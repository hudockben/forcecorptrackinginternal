#!/usr/bin/env node
'use strict';
/**
 * A failed read of the pick lists must never be saved back as the lists.
 *
 * Run: node scripts/test-lists-wipe-guard.js
 *
 * fct_lists holds turf's employee roster, equipment list, suppliers and cost
 * codes in one object. tracker.html read it with apiGet, which answers null
 * both when nothing is stored and when the request failed, and on null the
 * page carried on with the empty defaults. Since the CRM pick lists arrived,
 * loadLists() also seeds those into any blob without the seeded marker and
 * saves — and the empty defaults never carry the marker. So a single failed
 * read at page load saved empty employees, equipment and suppliers over the
 * company's real ones, leaving every project's Assigned Employees / Equipment
 * boxes blank. The server's bulk-wipe check only looks at array blobs, and
 * this one is an object, so it let the save through.
 *
 * Three halves, each pinned here:
 *
 *   The page. A failed read saves nothing, not even the months-old local copy
 *   it used to push back; saveLists() refuses until a read has succeeded; a
 *   retry finishes the load and redraws. An answered read behaves as before.
 *
 *   The server. A PUT of fct_lists, fct_paving_lists or fct_kiewit_lists may
 *   not empty or drop a list holding more than one entry — which also stops
 *   a tab still running the old page. One-at-a-time removal still works.
 *
 *   The empty box. The list div is written with nothing inside when the list
 *   is empty, so its :empty placeholder shows instead of a blank strip.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'tracker.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

/** A function out of tracker.html, `async` included when it has one. */
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in tracker.html`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

function extractConst(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} not found in tracker.html`);
  let depth = 0;
  for (let j = src.indexOf('[', start); j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return src.slice(start, j + 1) + ';';
  }
  throw new Error(`${name} is not closed`);
}

/** The whole lists section: LISTS_KEY and defaultLists down to saveLists(). */
function extractListsSection(src) {
  const start = src.indexOf("const LISTS_KEY = 'fct_lists';");
  if (start < 0) throw new Error('lists section not found in tracker.html');
  const save = extractFunction(src.slice(src.indexOf('function saveLists(', start)), 'saveLists');
  return src.slice(start, src.indexOf('function saveLists(', start)) + save;
}

// A company's lists as the server holds them.
const STORED = {
  employees: [
    { name: 'Allen Strick', non_prevailing_rate: 31.5, prevailing_rate: 52.1, job_class: 'Foreman' },
    { name: 'Ted Devalerio', non_prevailing_rate: 28, prevailing_rate: 49, job_class: 'Operator' },
    { name: 'Sam Ortiz', non_prevailing_rate: 24, prevailing_rate: 44, job_class: 'Laborer' },
  ],
  equipment: [{ name: 'CAT 299D', unit_cost: 65 }, { name: 'Skid Steer', unit_cost: 40 }],
  suppliers: [{ name: 'Acme Turf', state: 'PA', address: '', phone: '', website: '' },
              { name: 'Infill Co', state: 'NJ', address: '', phone: '', website: '' }],
  job_classes: ['Foreman', 'Operator', 'Laborer'],
  field_types: ['Soccer', 'Football'],
  infill_types: ['Crumb', 'Sand'],
  cost_codes: [{ value: '420', description: 'Turf' }, { value: '310', description: 'Base' }],
  _crm_lists_seeded: true,
};

/* ─────────────────────────────────────────────────────────────────────────
   1. The page
   ───────────────────────────────────────────────────────────────────────── */

/**
 * A fresh copy of the page's lists code with every outside call stubbed.
 * `respond` answers each GET: a {status, body} object, or 'network' to throw.
 */
function page({ respond, local = null, focused = null, tab = 'info' }) {
  const puts = [], banners = [], timers = [], draws = [];
  let logouts = 0;
  const fetch = async (url) => {
    const r = respond(url);
    if (r === 'network') throw new Error('Failed to fetch');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  const stubs = {
    fetch,
    API_BASE: '/api',
    fctToken: 'tok',
    logout: () => { logouts++; },
    localStorage: { getItem: () => (local ? JSON.stringify(local) : null) },
    apiPut: (key, value) => { puts.push({ key, value: JSON.parse(JSON.stringify(value)) }); },
    _showSaveError: (isAuth, msg, kept) => { banners.push({ isAuth, msg, kept }); },
    _fctSessionOver: () => false,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: {
      activeElement: focused ? { tagName: focused } : null,
      querySelector: () => null,
    },
    activeTab: tab,
    renderProjectsTab: () => draws.push('projects'),
    renderSupplierTab: () => draws.push('suppliers'),
    renderAllListPanels: () => draws.push('panels'),
  };
  const code = [
    extractFunction(SRC, 'apiGetChecked'),
    extractFunction(SRC, 'apiGet'),
    extractConst(SRC, '_CRM_LISTS'),
    extractFunction(SRC, '_crmSeedLists'),
    extractListsSection(SRC),
    `return {
       loadLists, saveLists, _redrawAfterListsLoad,
       get lists() { return lists; },
       get loaded() { return _listsLoaded; },
       get pending() { return _listsRedrawPending; },
     };`,
  ].join('\n');
  const api = new Function(...Object.keys(stubs), code)(...Object.values(stubs));
  // Runs the oldest queued retry, as the timer would.
  api.fireRetry = async () => { const t = timers.shift(); if (t) await t.fn(); return t; };
  return { api, puts, banners, timers, draws, logouts: () => logouts };
}

const listsPuts = puts => puts.filter(p => p.key === 'fct_lists');

(async () => {
  console.log('\n[a failed read saves nothing]');
  for (const [label, respond] of [
    ['a 503 from the account check', () => ({ status: 503, body: { error: 'Could not check your access' } })],
    ['a 500',                        () => ({ status: 500, body: { error: 'boom' } })],
    ['a dropped connection',         () => 'network'],
  ]) {
    const P = page({ respond });
    await P.api.loadLists();
    assert(`${label}: no PUT of the lists`, listsPuts(P.puts).length === 0,
      JSON.stringify(P.puts.map(p => ({ key: p.key, employees: (p.value.employees || []).length }))));
    assert(`${label}: the page knows it has not loaded`, P.api.loaded === false);
    assert(`${label}: the page still has lists to draw with`,
      Array.isArray(P.api.lists.employees) && Array.isArray(P.api.lists.equipment));
    assert(`${label}: a retry is queued`, P.timers.length === 1 && P.timers[0].ms === 2000,
      JSON.stringify(P.timers.map(t => t.ms)));
  }

  console.log('\n[a failed read does not push an old local copy back]');
  {
    const old = { employees: ['Somebody Who Left'], equipment: [] };
    const P = page({ respond: () => ({ status: 503, body: {} }), local: old });
    await P.api.loadLists();
    assert('the local copy is not written over the server', listsPuts(P.puts).length === 0,
      JSON.stringify(P.puts));
  }

  console.log('\n[nothing can be saved until the lists have loaded]');
  {
    const P = page({ respond: () => ({ status: 503, body: {} }) });
    await P.api.loadLists();
    P.api.lists.employees.push({ name: 'New Hire', non_prevailing_rate: 20, prevailing_rate: 40, job_class: '' });
    P.api.saveLists();
    assert('saveLists() refuses', listsPuts(P.puts).length === 0);
    assert('and says so', P.banners.length === 1 && /not loaded/.test(P.banners[0].msg), JSON.stringify(P.banners));
    assert('without claiming the edit was kept', P.banners[0] && P.banners[0].kept === false);
  }

  console.log('\n[a retry that succeeds finishes the load]');
  {
    let fail = true;
    const P = page({ respond: () => (fail ? { status: 503, body: {} } : { status: 200, body: { value: STORED } }) });
    await P.api.loadLists();
    fail = false;
    await P.api.fireRetry();
    assert('loaded', P.api.loaded === true);
    assert('the real roster is there', P.api.lists.employees.length === 3 && P.api.lists.equipment.length === 2);
    assert('the open project cards are redrawn', P.draws.includes('projects'), JSON.stringify(P.draws));
    assert('an already-seeded blob is not re-saved', listsPuts(P.puts).length === 0);
    P.api.saveLists();
    const saved = listsPuts(P.puts);
    assert('and saving works again, with everything in it',
      saved.length === 1 && saved[0].value.employees.length === 3 && saved[0].value.equipment.length === 2);
  }

  console.log('\n[retries back off, then stop]');
  {
    const P = page({ respond: () => ({ status: 503, body: {} }) });
    await P.api.loadLists();
    const waits = [];
    let t;
    while ((t = await P.api.fireRetry())) waits.push(t.ms);
    assert('2s, 5s, 15s, 30s', JSON.stringify(waits) === JSON.stringify([2000, 5000, 15000, 30000]), JSON.stringify(waits));
    assert('still nothing saved', listsPuts(P.puts).length === 0);
  }

  console.log('\n[a redraw waits for a field to be let go of]');
  {
    const P = page({ respond: () => ({ status: 200, body: { value: STORED } }), focused: 'INPUT' });
    await P.api.loadLists();
    P.api._redrawAfterListsLoad();
    assert('no redraw while typing', P.draws.length === 0);
    assert('the redraw is left pending for the poll', P.api.pending === true);
  }

  console.log('\n[an answered read behaves as before]');
  {
    const P = page({ respond: () => ({ status: 200, body: { value: STORED } }) });
    await P.api.loadLists();
    assert('loaded', P.api.loaded === true);
    assert('employees kept, rates and all',
      P.api.lists.employees[0].prevailing_rate === 52.1 && P.api.lists.employees[0].job_class === 'Foreman');
    assert('no save for a blob already seeded', listsPuts(P.puts).length === 0);
    assert('no retry queued', P.timers.length === 0);
  }
  {
    const unseeded = { ...STORED };
    delete unseeded._crm_lists_seeded;
    const P = page({ respond: () => ({ status: 200, body: { value: unseeded } }) });
    await P.api.loadLists();
    const saved = listsPuts(P.puts);
    assert('an unseeded blob that WAS read is seeded and saved once', saved.length === 1);
    assert('with the roster and equipment still in it',
      saved[0] && saved[0].value.employees.length === 3 && saved[0].value.equipment.length === 2);
    assert('and the CRM lists filled', saved[0] && saved[0].value.crm_sources.length > 0);
  }
  {
    // A company whose server has never held lists: the one case the local
    // copy is still carried over.
    const old = { employees: ['Allen Strick'], equipment: [{ name: 'Skid Steer', unit_cost: 40 }] };
    const P = page({ respond: () => ({ status: 200, body: { value: null } }), local: old });
    await P.api.loadLists();
    assert('the server answering "none" still carries the local copy over',
      listsPuts(P.puts).length >= 1 && P.api.lists.employees[0].name === 'Allen Strick');
  }
  {
    const P = page({ respond: () => ({ status: 200, body: { value: { employees: ['Legacy Name'] } } }) });
    await P.api.loadLists();
    assert('string employees are still migrated',
      P.api.lists.employees[0].name === 'Legacy Name' && P.api.lists.employees[0].non_prevailing_rate === 0);
  }

  console.log('\n[a 401 signs out and saves nothing]');
  {
    const P = page({ respond: () => ({ status: 401, body: {} }) });
    await P.api.loadLists();
    assert('signed out', P.logouts() === 1);
    assert('nothing saved', listsPuts(P.puts).length === 0);
  }

  /* ───────────────────────────────────────────────────────────────────────
     2. The server
     ─────────────────────────────────────────────────────────────────────── */

  const db = { value: null, exists: false };
  const orig = Module._load;
  Module._load = function (req, parent) {
    if (req === '@neondatabase/serverless') {
      return { neon: () => (strings, ...vals) => {
        const q = strings.join(' ').replace(/\s+/g, ' ').trim();
        if (/^SELECT value, updated_at FROM app_data/.test(q)) {
          return Promise.resolve(db.exists ? [{ value: db.value, updated_at: new Date() }] : []);
        }
        if (/^SELECT value FROM app_data/.test(q)) {
          return Promise.resolve(db.exists ? [{ value: db.value }] : []);
        }
        if (/^INSERT INTO app_data/.test(q)) {
          db.value = JSON.parse(vals[1]);
          db.exists = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }};
    }
    if (req === '../lib/auth' && parent && parent.filename.includes('data')) {
      return {
        requireAuth: async () => ({ companyCode: 'ACME', isPlatformAdmin: true, userId: 1, username: 'tester' }),
        hasDivisionAccess: () => true,
        hasAnyDivisionAccess: () => true,
        divisionForKey: () => null,
        isSharedKey: () => true,
        isCrossDivisionKey: () => false,
        isIcQuarryReadOnlyGet: () => false,
        CROSS_DIVISION_CONTRIBUTORS: [],
      };
    }
    if (req === '../lib/sync-normalized' && parent && parent.filename.includes('data')) {
      return { syncForKey: async () => {} };
    }
    return orig.apply(this, arguments);
  };
  const handler = require(path.join(ROOT, 'api', 'data', '[key].js'));
  Module._load = orig;

  const put = (key, value, query = {}) => new Promise(resolve => {
    const req = { method: 'PUT', query: { key, ...query }, headers: {}, body: { value } };
    const res = {
      setHeader() {}, status(c) { this._c = c; return this; },
      json(o) { resolve({ code: this._c || 200, body: o }); },
      end() { resolve({ code: this._c || 200, body: null }); },
    };
    handler(req, res);
  });
  const store = v => { db.value = JSON.parse(JSON.stringify(v)); db.exists = v !== null; };

  // Exactly what the page saved after a failed read: every list empty, the
  // CRM lists seeded, the marker set.
  const WIPE = {
    field_types: [], employees: [], job_classes: [], equipment: [], suppliers: [], infill_types: [],
    cost_codes: [], crm_contact_types: ['Athletic Director'], crm_org_types: ['School District'],
    crm_field_types: ['Football'], crm_turf_products: [], crm_sources: ['Referral'],
    crm_loss_reasons: ['Price'], crm_lead_contacts: [], _crm_lists_seeded: true,
  };

  console.log('\n[the server refuses to empty a list]');
  {
    store(STORED);
    const r = await put('fct_lists', WIPE);
    assert('the wipe is refused with 409', r.code === 409, JSON.stringify(r));
    assert('the stored roster survives', db.value.employees.length === 3 && db.value.equipment.length === 2);
    assert('the refusal names the lists', /employees \(3\)/.test(r.body.detail) && /equipment \(2\)/.test(r.body.detail),
      r.body && r.body.detail);
  }
  {
    store(STORED);
    const next = { ...STORED };
    delete next.employees;
    const r = await put('fct_lists', next);
    assert('dropping a list outright is refused too', r.code === 409, JSON.stringify(r));
  }
  {
    store(STORED);
    const r = await put('fct_lists', null);
    assert('so is saving null over the lists', r.code === 409, JSON.stringify(r));
  }
  for (const key of ['fct_paving_lists', 'fct_kiewit_lists']) {
    store(STORED);
    const r = await put(key, WIPE);
    assert(`${key} is guarded the same way`, r.code === 409, JSON.stringify(r));
  }

  console.log('\n[ordinary saves still land]');
  {
    store(STORED);
    const r = await put('fct_lists', { ...STORED, employees: STORED.employees.slice(0, 2) });
    assert('removing one employee', r.code === 200, JSON.stringify(r));
    assert('is stored', db.value.employees.length === 2);
  }
  {
    store({ ...STORED, employees: [STORED.employees[0]] });
    const r = await put('fct_lists', { ...STORED, employees: [] });
    assert('removing the last one', r.code === 200, JSON.stringify(r));
  }
  {
    store(STORED);
    const r = await put('fct_lists', { ...STORED, crm_sources: ['Referral'] });
    assert('adding a list the stored blob did not have', r.code === 200, JSON.stringify(r));
  }
  {
    store(null);
    const r = await put('fct_lists', WIPE);
    assert('the first save of a new company', r.code === 200, JSON.stringify(r));
  }
  {
    store(STORED);
    const r = await put('fct_lists', WIPE, { force: '1' });
    assert('a deliberate wipe with ?force=1', r.code === 200, JSON.stringify(r));
  }
  {
    store({ people: ['a', 'b'] });
    const r = await put('fct_presence', { people: [] });
    assert('other object blobs are left alone', r.code === 200, JSON.stringify(r));
  }

  /* ───────────────────────────────────────────────────────────────────────
     3. The empty box
     ─────────────────────────────────────────────────────────────────────── */

  console.log('\n[an empty list shows its placeholder]');
  {
    // :empty only matches an element with no text at all, whitespace
    // included, so the map must sit flush against both tags.
    const opens = SRC.match(/<div class="assign-list[^"]*">\$\{lists\.(employees|equipment)\.map\(/g) || [];
    assert('both lists open flush against the div', opens.length === 2, JSON.stringify(opens));
    const closes = SRC.match(/<\/label>`\)\.join\(''\)\}<\/div>/g) || [];
    assert('and close flush against it', closes.length >= 2, String(closes.length));
    assert('an unloaded list says so', /\.assign-list\.assign-list-unloaded:empty::after\s*\{\s*content:/.test(SRC));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
