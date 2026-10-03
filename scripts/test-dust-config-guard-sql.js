#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for the wipe guards on PUT /api/dust-config.
 *
 * Run: node scripts/test-dust-config-guard-sql.js
 *      (PG_TEST_URL overrides postgres://fct_test_user:test@localhost/fct_dustguard_test)
 *
 * Uses a database of its own so it can't trip over another suite's rows. The
 * database is created when missing (the role needs CREATEDB) and
 * auth-schema.sql then neon-schema.sql are applied on every run; both are
 * written to be re-run.
 *
 * DESTRUCTIVE: deletes every dust table row and dust app_data blob for the
 * TESTCO company, plus the legacy unscoped dust blobs. It refuses to run
 * against a database whose name doesn't look like a test database.
 *
 * What it pins: a Dust page that saves before its config has loaded sends its
 * blank starting state — UB rate 0, every list empty. Before the guard, that
 * replaced both blobs and zeroed dust_settings.ub_rate, so every UB gallon
 * priced at $0 and employee_rates / cost_codes (kept only in the blob) were
 * gone. This drives the real handler against a real PostgreSQL and asserts,
 * after each save, what both blobs, dust_settings and the normalized tables
 * hold, and what a GET then hands back to the page. It also pins the rate
 * rule's edges: a save that leaves the rate unchanged writes no rate (so a
 * rate saved meanwhile stands), a body with no usable ub_rate changes none,
 * a new rate is answered as dust_settings stores it, and the last entry of a
 * sparse config can still be removed by a page that loaded it and names the
 * lists it removed from — while a page that loaded the lists empty cannot
 * delete the first entry another tab has added since.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Client, Pool } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_dustguard_test';

// This deletes rows. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script deletes rows. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const CO   = 'TESTCO';
const ROOT = path.resolve(__dirname, '..');

// A pool rather than one Client: the handler fires its reads and syncs in
// parallel, which a single pg Client only queues with a deprecation warning.
let pool = null;

// A case can set this to run something just before a statement the handler
// sends, keyed on its text: another tab's save landing mid-request, say.
let beforeStatement = null;

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// the row array), so the handler cannot tell the difference.
function makeSql() {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    const go = () => pool.query(text, values).then(r => r.rows);
    return beforeStatement ? Promise.resolve(beforeStatement(text)).then(go) : go();
  };
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql() };
  if (request === './lib/auth') {
    return { requireAuth: async () => ({ companyCode: CO, userId: 1, username: 'dustguard', role: 'admin' }) };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.join(ROOT, 'api', 'dust-config.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
// Key order doesn't count: JSONB hands objects back with their keys sorted.
const canon = v => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const clone = v => JSON.parse(JSON.stringify(v));

async function call(method, body, query) {
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, headers: {}, body: body === undefined ? {} : body }, res);
  return res;
}
const put = (body, query) => call('PUT', body, query);
// The rate a PUT reports back, which the page keeps as its next ub_rate_base.
const rateOf = r => (r.body && r.body.settings) ? r.body.settings.ub_rate : undefined;

// ── Database ─────────────────────────────────────────────────────────────────

async function ensureDatabase() {
  // CREATE DATABASE can't take a bind parameter; dbName passed the /test/
  // check above, and is quoted as an identifier here.
  const cut   = URL.lastIndexOf('/' + dbName);
  const admin = new Client({ connectionString: URL.slice(0, cut) + '/postgres' + URL.slice(cut + 1 + dbName.length) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  pool = new Pool({ connectionString: URL, max: 6 });
  // Same order scripts/run-schema.js uses: companies must exist before the
  // dust tables that reference it.
  for (const f of ['auth-schema.sql', 'neon-schema.sql']) {
    await pool.query(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
}

const q = (t, v) => pool.query(t, v).then(r => r.rows);

async function reset() {
  await q(`INSERT INTO companies (code, name) VALUES ($1, 'Dust Guard Test') ON CONFLICT (code) DO NOTHING`, [CO]);
  // dust_companies cascades to its locations and personnel.
  await q(`DELETE FROM dust_companies WHERE company_code = $1`, [CO]);
  await q(`DELETE FROM dust_equipment WHERE company_code = $1`, [CO]);
  await q(`DELETE FROM dust_settings  WHERE company_code = $1`, [CO]);
  await q(`DELETE FROM dropdown_lists WHERE company_code = $1 AND list_name LIKE 'dust%'`, [CO]);
  await q(`DELETE FROM app_data WHERE key = ANY($1)`,
    [[`${CO}:dust_settings`, `${CO}:dust_lists`, 'dust_settings', 'dust_lists']]);
}

// Writes a config straight into the tables and both blobs, the way a
// long-running company's database looks, without going through the handler
// under test.
async function seed(cfg, opts = {}) {
  await reset();
  const { settings, lists } = cfg;
  await q(`INSERT INTO dust_settings (company_code, ub_rate) VALUES ($1, $2)`, [CO, settings.ub_rate]);
  for (const [i, e] of lists.equipment.entries()) {
    await q(`INSERT INTO dust_equipment (id, company_code, name, unit_number, vehicle_rate, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`, [e.id, CO, e.name, e.unit_number, e.vehicle_rate, i]);
  }
  for (const [i, c] of lists.companies.entries()) {
    await q(`INSERT INTO dust_companies (id, company_code, name, tier, v1_rate, v2_rate, ub_rate, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [c.id, CO, c.name, c.tier, c.v1_rate, c.v2_rate, c.ub_rate, i]);
    for (const [j, l] of c.locations.entries()) {
      await q(`INSERT INTO dust_company_locations (id, dust_company_id, name, state, sort_order)
               VALUES ($1, $2, $3, $4, $5)`, [l.id, c.id, l.name, l.state, j]);
    }
    for (const [j, p] of c.men.entries()) {
      await q(`INSERT INTO dust_company_personnel (id, dust_company_id, name, sort_order)
               VALUES ($1, $2, $3, $4)`, [p.id, c.id, p.name, j]);
    }
  }
  for (const [key, name] of [['employees', 'dust_employees'], ['materials', 'dust_materials'],
                             ['states', 'dust_states'], ['mu', 'dust_mu']]) {
    for (const [i, v] of lists[key].entries()) {
      await q(`INSERT INTO dropdown_lists (company_code, list_name, value, sort_order) VALUES ($1, $2, $3, $4)`,
        [CO, name, v, i]);
    }
  }
  // opts.blobs lets a case start from the state the incident left behind:
  // tables full, blobs blank.
  const blobs = opts.blobs || cfg;
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`, [`${CO}:dust_settings`, JSON.stringify(blobs.settings)]);
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)`, [`${CO}:dust_lists`,    JSON.stringify(blobs.lists)]);
}

// Everything a save could change, including the timestamps, so "nothing was
// written" is checked rather than inferred from the values alone.
async function snapshot() {
  // Timestamps as text: a Date would drop the microseconds two quick writes
  // can differ by.
  const blob = async k => (await q(`SELECT value, updated_at::text FROM app_data WHERE key = $1`, [k]))[0] || null;
  const s  = await blob(`${CO}:dust_settings`);
  const l  = await blob(`${CO}:dust_lists`);
  const ds = (await q(`SELECT ub_rate, updated_at::text FROM dust_settings WHERE company_code = $1`, [CO]))[0] || null;
  const dd = await q(`SELECT list_name, value FROM dropdown_lists WHERE company_code = $1 ORDER BY list_name, sort_order`, [CO]);
  const vals = n => dd.filter(r => r.list_name === n).map(r => r.value);
  const ids  = async t => (await q(`SELECT x.id FROM ${t} x JOIN dust_companies c ON c.id = x.dust_company_id
                                     WHERE c.company_code = $1 ORDER BY x.id`, [CO])).map(r => r.id);
  return {
    settingsBlob: s && s.value, settingsAt: s && s.updated_at,
    listsBlob:    l && l.value, listsAt:    l && l.updated_at,
    rate:   ds ? parseFloat(ds.ub_rate) : null, rateAt: ds && ds.updated_at,
    equipment: (await q(`SELECT id FROM dust_equipment WHERE company_code = $1 ORDER BY id`, [CO])).map(r => r.id),
    companies: (await q(`SELECT id FROM dust_companies WHERE company_code = $1 ORDER BY id`, [CO])).map(r => r.id),
    locations: await ids('dust_company_locations'),
    personnel: await ids('dust_company_personnel'),
    employees: vals('dust_employees'), materials: vals('dust_materials'),
    states:    vals('dust_states'),    mu:        vals('dust_mu'),
  };
}

function assertUnchanged(label, before, after) {
  const diff = Object.keys(before).filter(k => !same(before[k], after[k]));
  assert(`${label}: nothing was written (both blobs, dust_settings, every table)`, diff.length === 0,
    diff.map(k => `${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`).join('; '));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PM_FULL = {
  base_gal: 250, base_rate: 1.1, soap_gal: 5, soap_rate: 12,
  water_gal: 2000, water_rate: 0.01, mix_parts: 4, charge_basis: 'ub', charge: null,
};
// The page's starting state (dust.html: ubRate, profitMargin, dustLists).
const PM_BLANK = {
  base_gal: null, base_rate: null, soap_gal: null, soap_rate: null,
  water_gal: null, water_rate: null, mix_parts: null, charge_basis: 'invoice', charge: null,
};
const INCIDENT = {
  settings: { ub_rate: 0, profit_margin: PM_BLANK },
  lists: { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [], employee_rates: {}, cost_codes: [] },
};

const FULL = {
  settings: { ub_rate: 0.35, profit_margin: PM_FULL },
  lists: {
    equipment: [
      { id: 'dg-e1', name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 99 },
      { id: 'dg-e2', name: 'Escort Vehicle 7549',    unit_number: '7549', vehicle_rate: 50 },
    ],
    employees: ['Alice Adams', 'Bob Baker', 'Carl Cole'],
    companies: [
      { id: 'dg-co-cnx', name: 'CNX', tier: '', v1_rate: 135, v2_rate: 60, ub_rate: null,
        locations: [{ id: 'dg-l1', name: 'Deer Lick', state: 'PA' }, { id: 'dg-l2', name: 'Shirley', state: 'PA' }],
        men: [{ id: 'dg-p1', name: 'Steve Quinn' }, { id: 'dg-p2', name: 'Al Dorsey' }] },
      { id: 'dg-co-ant', name: 'Antero', tier: '', v1_rate: 145, v2_rate: null, ub_rate: 1.55,
        locations: [{ id: 'dg-l3', name: 'Bear Hollow', state: 'WV' }],
        men: [{ id: 'dg-p3', name: 'Max Lockerbie' }] },
      { id: 'dg-co-eqt', name: 'EQT', tier: '', v1_rate: null, v2_rate: null, ub_rate: null,
        locations: [], men: [] },
    ],
    materials: ['Ultra Bond', 'Calcium Chloride'],
    states: ['PA', 'WV'],
    mu: ['gal', 'ton'],
    employee_rates: { A: 30, B: 28 },
    cost_codes: [
      { id: 'cc1', code: '100', name: 'Labor',    sub_codes: [] },
      { id: 'cc2', code: '200', name: 'Material', sub_codes: [{ id: 'sc1', code: '201', name: 'Bond' }] },
    ],
  },
};
// What a page that loaded FULL sends back when it saves.
const fromLoaded = (mutate) => {
  const b = clone(FULL);
  b.settings.ub_rate_base = FULL.settings.ub_rate;
  if (mutate) mutate(b);
  return b;
};

// Every list holds exactly one entry: the per-list rule lets 1 -> 0 through
// (so items can be removed one at a time), and before the guard the sync
// deleted the lone company along with its locations and men.
const SINGLE = {
  settings: { ub_rate: 0.35, profit_margin: PM_FULL },
  lists: {
    equipment: [{ id: 'dg-e1', name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 99 }],
    employees: ['Alice Adams'],
    companies: [{ id: 'dg-co-cnx', name: 'CNX', tier: '', v1_rate: 135, v2_rate: 60, ub_rate: null,
      locations: [{ id: 'dg-l1', name: 'Deer Lick', state: 'PA' }, { id: 'dg-l2', name: 'Shirley', state: 'PA' }],
      men: [{ id: 'dg-p1', name: 'Steve Quinn' }] }],
    materials: ['Ultra Bond'],
    states: ['PA'],
    mu: ['gal'],
    employee_rates: { A: 30 },
    cost_codes: [{ id: 'cc1', code: '100', name: 'Labor', sub_codes: [] }],
  },
};

async function assertGet(label, want) {
  const g = await call('GET');
  const s = g.body && g.body.settings, l = (g.body && g.body.lists) || {};
  const got = {
    ub_rate: s && s.ub_rate,
    equipment: (l.equipment || []).length, companies: (l.companies || []).length,
    employees: (l.employees || []).length, materials: (l.materials || []).length,
    states: (l.states || []).length, mu: (l.mu || []).length,
    employee_rates: Object.keys(l.employee_rates || {}).length,
    cost_codes: (l.cost_codes || []).length,
  };
  const diff = Object.keys(want).filter(k => k !== 'extra' && got[k] !== want[k]);
  assert(`${label}: GET hands the page what is stored`, g.statusCode === 200 && diff.length === 0,
    `status ${g.statusCode}; ` + diff.map(k => `${k} got ${got[k]} want ${want[k]}`).join(', '));
  return g.body;
}
const GET_FULL = { ub_rate: 0.35, equipment: 2, companies: 3, employees: 3, materials: 2, states: 2, mu: 2,
                   employee_rates: 2, cost_codes: 2 };

// ── Cases ────────────────────────────────────────────────────────────────────

async function run() {
  await ensureDatabase();

  console.log('\n[1] the incident payload over a loaded company');
  {
    await seed(FULL);
    const before = await snapshot();
    const r = await put(clone(INCIDENT));
    assert('refused with 409', r.statusCode === 409, `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('error names the refusal', r.body && r.body.error === 'Refusing to wipe dust config');
    const codes = (r.body && r.body.refused) || [];
    assert('refused lists the blank lists and the zeroed rate',
      codes.includes('blank_lists') && codes.includes('zero_ub_rate')
      && codes.includes('empty_companies') && codes.includes('empty_employee_rates')
      && codes.includes('empty_cost_codes'), JSON.stringify(codes));
    const d = String(r.body && r.body.detail);
    assert('detail says what would have gone and to reload',
      /companies \(3\)/.test(d) && /employee rates \(2\)/.test(d) && /\$0\.35/.test(d) && /Reload the page/.test(d), d);
    // The refused save is usually a row edit's, and the row itself was saved:
    // "Nothing was saved ... make your change again" had people redo it.
    assert('detail says the tracking rows are not affected, not that nothing was saved',
      /Tracking rows save separately and are not affected/.test(d) && !/Nothing was saved/.test(d), d);
    assertUnchanged('incident payload', before, await snapshot());
    const g = await assertGet('incident payload', GET_FULL);
    assert('GET still carries profit_margin, employee_rates and the company tree',
      same(g.settings.profit_margin, PM_FULL) && same(g.lists.employee_rates, { A: 30, B: 28 })
      && g.lists.companies[0].locations.length === 2 && g.lists.companies[0].men.length === 2,
      JSON.stringify(g.settings.profit_margin));
  }

  console.log('\n[1b] after the incident: blobs blank, tables still full');
  {
    // Stored size is the larger of blob and table, or nothing would be
    // guarded once the blob had already been blanked.
    await seed(FULL, { blobs: clone(INCIDENT) });
    const before = await snapshot();
    const r = await put(fromLoaded(b => { b.lists.companies = []; }));
    assert('emptying companies is refused on the table count alone', r.statusCode === 409
      && same(r.body.refused, ['empty_companies']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assertUnchanged('companies over blank blob', before, await snapshot());
  }

  console.log('\n[2] blank payload over single-entry lists');
  {
    await seed(SINGLE);
    const before = await snapshot();
    const r = await put(Object.assign(clone(INCIDENT), { settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_BLANK } }));
    assert('refused with 409 even with the rate untouched', r.statusCode === 409
      && same(r.body.refused, ['blank_lists']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('detail names the single entries', /companies \(1\)/.test(r.body.detail) && /materials \(1\)/.test(r.body.detail),
      r.body.detail);
    const after = await snapshot();
    assertUnchanged('single-entry lists', before, after);
    assert('the lone company keeps both locations and its man',
      same(after.companies, ['dg-co-cnx']) && same(after.locations, ['dg-l1', 'dg-l2']) && same(after.personnel, ['dg-p1']));
    await assertGet('single-entry lists', { ub_rate: 0.35, companies: 1, materials: 1, employee_rates: 1, cost_codes: 1 });
  }

  console.log('\n[3] removing one employee');
  {
    await seed(FULL);
    const r = await put(fromLoaded(b => { b.lists.employees = ['Alice Adams', 'Bob Baker']; }));
    assert('saved with 200', r.statusCode === 200 && r.body.ok === true, `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('response carries the rate in effect', rateOf(r) === 0.35,
      JSON.stringify(r.body));
    const s = await snapshot();
    assert('employee gone from dropdown_lists', same(s.employees, ['Alice Adams', 'Bob Baker']), JSON.stringify(s.employees));
    assert('employee gone from the lists blob', same(s.listsBlob.employees, ['Alice Adams', 'Bob Baker']));
    assert('UB rate stays 0.35 in dust_settings and the blob', s.rate === 0.35 && s.settingsBlob.ub_rate === 0.35,
      `${s.rate} / ${s.settingsBlob.ub_rate}`);
    assert('ub_rate_base is not stored in the settings blob', !('ub_rate_base' in s.settingsBlob),
      JSON.stringify(s.settingsBlob));
    assert('profit_margin saved as sent', same(s.settingsBlob.profit_margin, PM_FULL));
    await assertGet('one employee removed', Object.assign({}, GET_FULL, { employees: 2 }));
  }

  console.log('\n[4] removing the last item of a one-item list');
  {
    const cfg = clone(FULL);
    cfg.lists.materials = ['Ultra Bond'];
    await seed(cfg);
    const r = await put(fromLoaded(b => { b.lists.materials = []; }));
    assert('saved with 200', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('materials now empty in table and blob', s.materials.length === 0 && same(s.listsBlob.materials, []),
      JSON.stringify(s.materials));
    assert('everything else intact', s.companies.length === 3 && s.employees.length === 3 && s.rate === 0.35);
    await assertGet('last material removed', Object.assign({}, GET_FULL, { materials: 0 }));
  }

  console.log('\n[5] changing the UB rate in this tab');
  {
    await seed(FULL);
    const r = await put(fromLoaded(b => { b.settings.ub_rate = 0.5; }));
    assert('saved with 200, response says 0.5', r.statusCode === 200 && rateOf(r) === 0.5,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('0.50 in dust_settings and the blob', s.rate === 0.5 && s.settingsBlob.ub_rate === 0.5,
      `${s.rate} / ${s.settingsBlob.ub_rate}`);
    await assertGet('rate changed', Object.assign({}, GET_FULL, { ub_rate: 0.5 }));
  }

  console.log('\n[6] zeroing the UB rate');
  {
    await seed(FULL);
    let r = await put(fromLoaded(b => { b.settings.ub_rate = 0; }));
    assert('deliberate 0 from a tab that loaded 0.35: 200', r.statusCode === 200 && rateOf(r) === 0,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    let s = await snapshot();
    assert('0 stored in dust_settings and the blob', s.rate === 0 && s.settingsBlob.ub_rate === 0);
    await assertGet('deliberate 0', Object.assign({}, GET_FULL, { ub_rate: 0 }));

    // A page from before ub_rate_base can't say whether 0 was typed or is its
    // blank start, so it can't zero a stored rate.
    await seed(FULL);
    const before = await snapshot();
    r = await put(Object.assign(clone(FULL), { settings: { ub_rate: 0, profit_margin: PM_FULL } }));
    assert('old page (no base) sending 0 over 0.35: 409', r.statusCode === 409
      && same(r.body.refused, ['zero_ub_rate']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('detail names the rate', /UB gallon rate from \$0\.35 to \$0/.test(r.body.detail), r.body.detail);
    assertUnchanged('old page zeroing', before, await snapshot());
    await assertGet('old page zeroing', GET_FULL);

    r = await put(Object.assign(clone(FULL), { settings: { ub_rate: 0.4, profit_margin: PM_FULL } }));
    assert('old page (no base) sending 0.40: 200', r.statusCode === 200 && rateOf(r) === 0.4,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    s = await snapshot();
    assert('0.40 stored', s.rate === 0.4 && s.settingsBlob.ub_rate === 0.4);

    r = await put(Object.assign(clone(FULL), { settings: { ub_rate: 0, profit_margin: PM_FULL } }), { force: '1' });
    assert('?force=1 with no base and 0: 200', r.statusCode === 200 && rateOf(r) === 0,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    s = await snapshot();
    assert('forced 0 stored', s.rate === 0 && s.settingsBlob.ub_rate === 0);
  }

  console.log('\n[7] a stale tab whose rate was changed elsewhere');
  {
    await seed(FULL);
    // Another tab set 0.42 after this one loaded 0.35.
    await q(`UPDATE dust_settings SET ub_rate = 0.42 WHERE company_code = $1`, [CO]);
    await q(`UPDATE app_data SET value = jsonb_set(value, '{ub_rate}', '0.42') WHERE key = $1`, [`${CO}:dust_settings`]);
    const r = await put(fromLoaded(b => { b.lists.states = ['PA', 'WV', 'OH']; }));
    assert('saved with 200, response says 0.42', r.statusCode === 200 && rateOf(r) === 0.42,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('0.42 kept in dust_settings and the blob', s.rate === 0.42 && s.settingsBlob.ub_rate === 0.42,
      `${s.rate} / ${s.settingsBlob.ub_rate}`);
    assert('the list edit still landed', same(s.states, ['PA', 'WV', 'OH']), JSON.stringify(s.states));
    await assertGet('stale tab', Object.assign({}, GET_FULL, { ub_rate: 0.42, states: 3 }));
  }

  console.log('\n[8] a stale tab emptying a blob-only list');
  {
    await seed(FULL);
    let before = await snapshot();
    let r = await put(fromLoaded(b => { b.lists.employee_rates = {}; }));
    assert('employee_rates 2 keys -> {}: 409', r.statusCode === 409
      && same(r.body.refused, ['empty_employee_rates']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assertUnchanged('employee_rates emptied', before, await snapshot());

    before = await snapshot();
    r = await put(fromLoaded(b => { b.lists.cost_codes = []; }));
    assert('cost_codes 2 -> []: 409', r.statusCode === 409
      && same(r.body.refused, ['empty_cost_codes']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assertUnchanged('cost_codes emptied', before, await snapshot());
    await assertGet('blob-only lists', GET_FULL);
  }

  console.log('\n[9] a brand-new company saving a blank first config');
  {
    await reset();
    const r = await put(clone(INCIDENT));
    assert('saved with 200', r.statusCode === 200 && rateOf(r) === 0,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('both blobs and dust_settings written', s.settingsBlob && s.listsBlob && s.rate === 0
      && same(s.listsBlob.cost_codes, []), JSON.stringify(s));
    await assertGet('new company', { ub_rate: 0, equipment: 0, companies: 0, employees: 0, employee_rates: 0 });

    // And its first real rate goes through with lists still empty.
    const r2 = await put(Object.assign(clone(INCIDENT), { settings: { ub_rate: 0.3, ub_rate_base: 0, profit_margin: PM_BLANK } }));
    assert('first rate on an empty company: 200', r2.statusCode === 200 && rateOf(r2) === 0.3,
      `${r2.statusCode} ${JSON.stringify(r2.body)}`);
  }

  console.log('\n[10] a body carrying only one side');
  {
    await seed(FULL);
    let before = await snapshot();
    let r = await put({ settings: { ub_rate: 0.5, ub_rate_base: 0.35, profit_margin: PM_FULL } });
    assert('settings only: 200', r.statusCode === 200 && rateOf(r) === 0.5,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    let s = await snapshot();
    assert('lists blob untouched (value and timestamp)', same(s.listsBlob, before.listsBlob) && s.listsAt === before.listsAt);
    assert('list tables untouched', ['equipment', 'companies', 'locations', 'personnel', 'employees', 'materials', 'states', 'mu']
      .every(k => same(s[k], before[k])));
    assert('rate written', s.rate === 0.5 && s.settingsBlob.ub_rate === 0.5);

    await seed(FULL);
    before = await snapshot();
    r = await put({ lists: fromLoaded(b => { b.lists.employees = ['Alice Adams', 'Bob Baker']; }).lists });
    assert('lists only: 200, response says the stored 0.35', r.statusCode === 200 && rateOf(r) === 0.35,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    s = await snapshot();
    assert('dust_settings untouched (value and timestamp)', s.rate === 0.35 && s.rateAt === before.rateAt);
    assert('settings blob untouched (value and timestamp)',
      same(s.settingsBlob, before.settingsBlob) && s.settingsAt === before.settingsAt);
    assert('list edit landed', same(s.employees, ['Alice Adams', 'Bob Baker']));
    await assertGet('one side only', Object.assign({}, GET_FULL, { employees: 2 }));
  }

  console.log('\n[11] a settings save with no usable ub_rate');
  {
    // It once read as 0, and with a base present 0 is a deliberate change:
    // a save meant only for the profit margin zeroed the rate.
    for (const [label, ub] of [['missing', undefined], ['null', null], ['empty string', '']]) {
      await seed(FULL);
      const settings = { profit_margin: Object.assign({}, PM_FULL, { base_rate: 2.2 }), ub_rate_base: 0.35 };
      if (ub !== undefined) settings.ub_rate = ub;
      const r = await put({ settings });
      assert(`ub_rate ${label}, base 0.35: 200 with the stored 0.35`, r.statusCode === 200 && rateOf(r) === 0.35,
        `${r.statusCode} ${JSON.stringify(r.body)}`);
      const s = await snapshot();
      assert(`  ub_rate ${label}: 0.35 kept in dust_settings and the blob`, s.rate === 0.35 && s.settingsBlob.ub_rate === 0.35,
        `${s.rate} / ${s.settingsBlob.ub_rate}`);
      assert(`  ub_rate ${label}: the profit margin it carried was saved`, s.settingsBlob.profit_margin.base_rate === 2.2);
    }
  }

  console.log('\n[12] a rate saved by another tab while an unchanged-rate save is running');
  {
    // Tab B (rate untouched, base 0.35) saves a list edit. Its PUT reads the
    // stored 0.35; tab A's change to 0.50 lands before B writes anything.
    // B used to write the 0.35 it had read back over A's 0.50.
    await seed(FULL);
    let fired = false;
    beforeStatement = async text => {
      if (fired || !/INSERT INTO (app_data|dust_settings)/.test(text)) return;
      fired = true;
      await q(`UPDATE dust_settings SET ub_rate = 0.5 WHERE company_code = $1`, [CO]);
      await q(`UPDATE app_data SET value = jsonb_set(value, '{ub_rate}', '0.5') WHERE key = $1`, [`${CO}:dust_settings`]);
    };
    let r;
    try { r = await put(fromLoaded(b => { b.lists.states = ['PA', 'WV', 'OH']; })); }
    finally { beforeStatement = null; }
    assert('the other tab\'s save did land mid-request (the case means something)', fired);
    assert('B: 200, answering with the rate stored now, 0.50', r.statusCode === 200 && rateOf(r) === 0.5,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('0.50 stands in dust_settings and the blob', s.rate === 0.5 && s.settingsBlob.ub_rate === 0.5,
      `${s.rate} / ${s.settingsBlob.ub_rate}`);
    assert('B\'s list edit and profit margin landed', same(s.states, ['PA', 'WV', 'OH'])
      && same(s.settingsBlob.profit_margin, PM_FULL));
  }

  console.log('\n[13] a new rate with more decimals than dust_settings keeps');
  {
    await seed(FULL);
    const r = await put(fromLoaded(b => { b.settings.ub_rate = 0.12345; }));
    const s = await snapshot();
    assert('the answer, the blob and dust_settings all say 0.1235',
      r.statusCode === 200 && rateOf(r) === 0.1235 && s.settingsBlob.ub_rate === 0.1235 && s.rate === 0.1235,
      `${JSON.stringify(r.body)} / blob ${s.settingsBlob.ub_rate} / table ${s.rate}`);
  }

  console.log('\n[14] removing the only entry a sparse config holds');
  {
    // A company still being set up: a rate and one state, every list else
    // empty. Removing the state empties every list — which the blank rule
    // refused every time, reload or not.
    const SPARSE = clone(FULL);
    SPARSE.lists = { equipment: [], employees: [], companies: [], materials: [], states: ['PA'], mu: [],
                     employee_rates: {}, cost_codes: [] };
    await seed(SPARSE);
    let before = await snapshot();
    let r = await put({ settings: { ub_rate: 0.35, profit_margin: PM_FULL },
                        lists: Object.assign(clone(SPARSE.lists), { states: [] }) });
    assert('from a page that cannot show it loaded (no base): still 409', r.statusCode === 409
      && same(r.body.refused, ['blank_lists']), `${r.statusCode} ${JSON.stringify(r.body)}`);
    assertUnchanged('sparse config, no base', before, await snapshot());
    r = await put({ settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_FULL },
                    lists: Object.assign(clone(SPARSE.lists), { states: [] }), lists_removed: ['states'] });
    assert('from a page that loaded it and removed it (base sent, states named): 200', r.statusCode === 200,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('the state is gone from the table and the blob', s.states.length === 0 && same(s.listsBlob.states, []),
      JSON.stringify(s.states));
  }

  console.log('\n[15] a page that loaded the lists empty, after another tab added the first entry');
  {
    // Tab A loads a company still being set up: a rate, every list empty.
    // Tab B adds its first customer, with a well pad and a company man. A's
    // next save (its hide flush, say, before its poll caught up) carries A's
    // empty lists and a base — and names no list it removed from.
    const EMPTY = clone(FULL);
    EMPTY.lists = { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [],
                    employee_rates: {}, cost_codes: [] };
    await seed(EMPTY);
    const onlyCnx = Object.assign(clone(EMPTY.lists), { companies: [clone(FULL.lists.companies[0])] });
    let r = await put({ settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_FULL }, lists: onlyCnx });
    assert('tab B adds CNX: 200', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const before = await snapshot();
    r = await put({ settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_FULL },
                    lists: clone(EMPTY.lists), lists_removed: [] });
    assert('tab A\'s blank save: 409 blank_lists', r.statusCode === 409 && same(r.body.refused, ['blank_lists']),
      `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assertUnchanged('tab A\'s blank save', before, s);
    assert('  CNX, its well pads and its company men are still there',
      same(s.companies, ['dg-co-cnx']) && same(s.locations, ['dg-l1', 'dg-l2']) && same(s.personnel, ['dg-p1', 'dg-p2']),
      JSON.stringify([s.companies, s.locations, s.personnel]));
    r = await put({ settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_FULL },
                    lists: clone(EMPTY.lists), lists_removed: ['states'] });
    assert('  and naming some other list does not get it through: 409', r.statusCode === 409,
      `${r.statusCode} ${JSON.stringify(r.body)}`);
  }

  console.log('\n[16] removing the only employee, who has a labor rate');
  {
    // The employee and the rate count as two entries, so a cap of one entry
    // refused this every time, reload or not.
    const LONE = clone(FULL);
    LONE.lists = { equipment: [], employees: ['Alice Adams'], companies: [], materials: [], states: [], mu: [],
                   employee_rates: { 'Alice Adams': 30 }, cost_codes: [] };
    await seed(LONE);
    const r = await put({ settings: { ub_rate: 0.35, ub_rate_base: 0.35, profit_margin: PM_FULL },
                          lists: Object.assign(clone(LONE.lists), { employees: [], employee_rates: {} }),
                          lists_removed: ['employees', 'employee_rates'] });
    assert('removed by a page that loaded it: 200', r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const s = await snapshot();
    assert('  Alice and her rate are gone from the table and the blob', s.employees.length === 0
      && same(s.listsBlob.employees, []) && same(s.listsBlob.employee_rates, {}),
      JSON.stringify([s.employees, s.listsBlob.employees, s.listsBlob.employee_rates]));
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
}

run()
  .then(() => pool && pool.end())
  .then(() => process.exit(failed ? 1 : 0))
  .catch(err => { console.error(err); if (pool) pool.end(); process.exit(1); });
