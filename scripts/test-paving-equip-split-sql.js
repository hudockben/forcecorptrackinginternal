#!/usr/bin/env node
'use strict';
/**
 * Paving's Labor → Equipment split, Executive report vs the Bid Items page,
 * against a real PostgreSQL.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-paving-equip-split-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Not destructive: every row goes into a TEMP daily_tracking table, which
 * shadows the real one for this connection only and is gone when it closes.
 * No schema needs to be loaded first.
 *
 * scripts/test-paving-equip-split.js checks the rule on the page and checks
 * pavingEquipToEquipLine() against it through a fake sql tag. The fake has to
 * restate what the query does, so what Postgres itself makes of the query is
 * checked here: the equipment each group carries, capped row by row at the
 * row's cost, with travel rows left out by the same patterns the page uses
 * (Postgres's own \s, \m and \M follow the locale; the page's do not). Each
 * job's projected cost, off-bid spend and actual from buildFinancials have to
 * equal what paving.html's own projectedCostForProject(), offBidForProject()
 * and row costs give — on the cases that matter and on a seeded random sweep.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { Client } = require('pg');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const URL  = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'paving.html'), 'utf8');
const report = require(path.join(ROOT, 'api/executive/report.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.005;

// ── The page, lifted ────────────────────────────────────────────────────────
const LIFT = ['calcDaily', 'dailyRowCost', '_bidEachCostPiece', 'actualForBidItem', 'runningQtyForBidItem',
  'offBidForProject', 'projIsDone', 'projForBidItem', 'projectedCostForProject'];
const ctx = vm.createContext({ console });
vm.runInContext([
  SRC.slice(SRC.indexOf('const HAUL_FIELD_TYPE_RE ='), SRC.indexOf('\n', SRC.indexOf('const HAUL_FIELD_TYPE_RE ='))),
  'let pvPreview = { active: false, rate: 0 };',
  'let projectsList = [];',
  'function getProj(id) { return projectsList.find(p => p.id === id); }',
  'function getAllDailyRows() { return projectsList.reduce((a, p) => a.concat(p.dailyRows || []), []); }',
  'function bidItemComplete(b) { return !!b.is_complete; }',
  ...LIFT.map(n => requireFn(SRC, n, 'paving.html')),
  `this.__t = { set(list) { projectsList = list; }, ${LIFT.join(', ')} };`,
].join('\n'), ctx);
const t = ctx.__t;

// ── Fixtures ────────────────────────────────────────────────────────────────
const CC = '1 1/2" 9.5MM Overlay', LAB = CC + ' - Labor', EQP = CC + ' - Equipment', TRV = CC + ' - Travel';
const STD = [
  { cost_code: CC, sub_code: LAB, quantity: '7046', unit_cost: '1.20' },
  { cost_code: CC, sub_code: EQP, quantity: '1',    unit_cost: '2500' },
  { cost_code: CC, sub_code: TRV, quantity: '20',   unit_cost: '64.90' },
];
let rowSeq = 0;
const lab = (o = {}) => Object.assign({ id: 'r' + (++rowSeq), date: '2026-11-06', cost_code: CC, sub_code: LAB,
  rate: '55', labor_hours: '10.75', equip_unit_cost: '85', equip_hours: '9', quantity: '3523' }, o);
const job = (rows, bids = STD) => ({ id: 'p26058', status: 'Active', bidItems: bids.map(b => Object.assign({}, b)), dailyRows: rows });
const bids = (...subs) => subs.map(([cc, sc]) => ({ cost_code: cc, sub_code: sc, quantity: '100', unit_cost: '10' }));
// Complete lines project at their actual, so money counted twice shows in the
// projection instead of hiding under an unfinished line's bid.
const done = list => list.map(b => Object.assign(b, { is_complete: true }));

const CASES = [
  ['the Weiler on the Labor line', job([lab(), lab({ employee: 'Lucas Mower', rate: '45', labor_hours: '10.5', equip_hours: '0' })])],
  ['a Travel-stamped row on the Labor sub code keeps its pickup', job([lab(), lab({ field_type: 'Travel', labor_hours: '0.5', equip_unit_cost: '35', equip_hours: '0.5', quantity: '' })])],
  ['…the stamp in any case, with spaces', job([lab(), lab({ field_type: '  TRAVEL ', equip_hours: '1' })])],
  ['…a no-break space is not a space, on either side', job([lab({ field_type: 'Travel ' })])],
  ['…nor a newline', job([lab({ field_type: 'Travel\n' })])],
  ['travel as a word in the cost code', job([lab({ cost_code: 'Travel Overlay', sub_code: 'Travel Overlay - Labor' })],
    bids(['Travel Overlay', 'Travel Overlay - Labor'], ['Travel Overlay', 'Travel Overlay - Equipment']))],
  ['travel as a word in the sub code', job([lab({ sub_code: 'Labor-Travel' })], bids([CC, 'Labor-Travel'], [CC, EQP]))],
  ['…after a non-ASCII letter', job([lab({ sub_code: 'Labor éTravel' })], bids([CC, 'Labor éTravel'], [CC, EQP]))],
  ['…but not inside a longer word', job([lab({ sub_code: 'Labor - Travelers' })], bids([CC, 'Labor - Travelers'], [CC, EQP]))],
  ['an imported total below the machine', job([lab({ total_cost: '300' })])],
  ['an equipment total typed in', job([lab({ equip_total_override: '1000', equip_hours: '0' })])],
  ['an equipment credit', job([lab({ equip_total_override: '-50', equip_hours: '0' })])],
  ['"Labour"', job([lab({ sub_code: CC + ' - Labour' })], bids([CC, CC + ' - Labour'], [CC, EQP]))],
  ['two Equipment lines: the first takes it', job([lab()], bids([CC, LAB], [CC, CC + ' - Equip Rental'], [CC, EQP]))],
  ['"Labor & Equipment" is neither the Labor row nor the Equipment line', job([lab(), lab({ sub_code: 'Labor & Equipment' })],
    bids([CC, 'Labor & Equipment'], [CC, LAB], [CC, EQP]))],
  ['Labor not on the bid: the machine still reaches Equipment', job([lab()], bids([CC, EQP]))],
  ['no Equipment line: nothing moves', job([lab()], bids([CC, LAB]))],
  ['a cost-code-only line beside Equipment, no Labor line: nothing moves', job([lab()], done(bids([CC, ''], [CC, EQP])))],
  ['a cost-code-only line beside Labor and Equipment: it still splits', job([lab()], done(bids([CC, ''], [CC, LAB], [CC, EQP])))],
  ['Labor not on the bid, all lines complete', job([lab()], done(bids([CC, EQP])))],
  ['a sub-code-only Labor line', job([lab()], bids(['', LAB], [CC, EQP]))],
  ['no cost code on the row', job([lab({ cost_code: '' })])],
  ['no sub code on the row', job([lab({ sub_code: '' })])],
  ['material on the Labor row', job([lab({ material_cost: '120' })])],
  ['everything complete', job([lab(), lab({ field_type: 'Travel' })], STD.map(b => Object.assign({}, b, { is_complete: true })))],
];

// A seeded sweep over the shapes a paving job's rows and bid take.
function sweep(n) {
  let seed = 26058;
  const rnd  = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const CCS  = ['Overlay', 'Mill', 'Travel Base', ''];
  const SUBS = cc => [cc + ' - Labor', cc + ' - Labour', cc + ' - Equipment', cc + ' - Travel', cc + ' - Trucking',
    cc + ' - Material', '', 'Labor Travel', 'Equip Labor', 'Labor & Equipment'];
  const FTS  = ['', '', 'Travel', ' travel ', 'Haul — On Site'];
  const out = [];
  for (let j = 0; j < n; j++) {
    const rows = [], bidItems = [];
    for (let i = 0, m = 2 + Math.floor(rnd() * 12); i < m; i++) {
      const cc = pick(CCS);
      const r = { id: `s${j}-${i}`, date: pick(['2026-10-01', '2026-11-06', '2026-11-20']), cost_code: cc, sub_code: pick(SUBS(cc)),
        field_type: pick(FTS), rate: String(Math.floor(rnd() * 60)), labor_hours: String(Math.floor(rnd() * 12)),
        equip_unit_cost: String(Math.floor(rnd() * 100)), equip_hours: String(Math.floor(rnd() * 10)),
        material_cost: rnd() < 0.2 ? String(Math.floor(rnd() * 1000)) : '', quantity: rnd() < 0.5 ? String(Math.floor(rnd() * 500)) : '' };
      if (rnd() < 0.2) r.equip_total_override = String(Math.floor(rnd() * 900));
      if (rnd() < 0.2) r.total_cost = String(Math.floor(rnd() * 1500) + 1);   // the page reads only a positive one
      rows.push(r);
    }
    for (let i = 0, m = 1 + Math.floor(rnd() * 6); i < m; i++) {
      const cc = pick(CCS);
      bidItems.push({ cost_code: cc, sub_code: pick(SUBS(cc)), quantity: String(Math.floor(rnd() * 900)),
        unit_cost: String(Math.floor(rnd() * 40)), is_complete: rnd() < 0.3 });
    }
    out.push({ id: 'sweep' + j, status: 'Active', bidItems, dailyRows: rows });
  }
  return out;
}

// ── Postgres ────────────────────────────────────────────────────────────────
(async () => {
  const c = new Client({ connectionString: URL });
  try { await c.connect(); }
  catch (e) { console.error(`Cannot reach ${URL.replace(/:[^:@/]*@/, ':***@')}: ${e.message}`); process.exit(1); }

  // pg_temp only: never the real table. A real server gives each connection
  // its own temp schema; this clears one left by a run on a shared session.
  await c.query('DROP TABLE IF EXISTS pg_temp.daily_tracking');
  await c.query(`CREATE TEMP TABLE daily_tracking (
    id SERIAL PRIMARY KEY, date DATE NOT NULL, field_type VARCHAR(255), employee VARCHAR(255),
    cost_code VARCHAR(255), sub_code VARCHAR(255), job_class VARCHAR(255),
    rate NUMERIC(14,4) NOT NULL DEFAULT 0, labor_hours NUMERIC(14,4) NOT NULL DEFAULT 0,
    equipment VARCHAR(255), equip_unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
    equip_hours NUMERIC(14,4) NOT NULL DEFAULT 0, material_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
    quantity NUMERIC(14,4) NOT NULL DEFAULT 0, project_id TEXT NOT NULL, company_code TEXT NOT NULL,
    division TEXT NOT NULL, equip_total_override NUMERIC(14,4), total_cost_override NUMERIC(14,4))`);

  // buildFinancials' tag: $1, $2, … in the order the values come, as Neon's.
  let lastValues = null;
  const sql = async (strings, ...values) => {
    let text = strings[0];
    values.forEach((v, i) => { text += '$' + (i + 1) + strings[i + 1]; });
    if (/from daily_tracking/i.test(text)) lastValues = values;
    return (await c.query(text, values)).rows;
  };
  const num = v => (v === '' || v == null) ? null : Number(v);
  async function load(p) {
    await c.query('DELETE FROM daily_tracking');
    for (const r of p.dailyRows) {
      await c.query(`INSERT INTO daily_tracking (project_id, company_code, division, date, field_type, cost_code, sub_code,
          rate, labor_hours, equip_unit_cost, equip_hours, material_cost, quantity, equip_total_override, total_cost_override)
        VALUES ($1, 'C', 'paving', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [p.id, r.date, r.field_type || null, r.cost_code || null, r.sub_code || null,
         num(r.rate) || 0, num(r.labor_hours) || 0, num(r.equip_unit_cost) || 0, num(r.equip_hours) || 0,
         num(r.material_cost) || 0, num(r.quantity) || 0, num(r.equip_total_override), num(r.total_cost)]);
    }
  }
  async function compare(p) {
    t.set([p]);
    await load(p);
    const e = (await report.buildFinancials(sql, 'C', 'paving', [p])).perProject.get(p.id);
    const page = {
      projected: t.projectedCostForProject(p),
      offBid:    t.offBidForProject(p).total,
      actual:    p.dailyRows.reduce((s, r) => s + t.dailyRowCost(r), 0),
    };
    const ok = near(e.projected, page.projected) && near(e.offBid, page.offBid) && near(e.actual, page.actual);
    return { ok, detail: `Executive projected ${e.projected.toFixed(2)} / off-bid ${e.offBid.toFixed(2)} / actual ${e.actual.toFixed(2)}`
      + ` — page ${page.projected.toFixed(2)} / ${page.offBid.toFixed(2)} / ${page.actual.toFixed(2)}` };
  }

  console.log('\n[the Executive report projects each case as the Bid Items page does]');
  for (const [label, p] of CASES) {
    const r = await compare(p);
    assert(label, r.ok, r.detail);
  }
  assert('company, division and job ids are still the query\'s first three parameters',
    lastValues && lastValues[0] === 'C' && lastValues[1] === 'paving' && Array.isArray(lastValues[2]));

  console.log('\n[…and on a seeded sweep]');
  const jobs = sweep(150);
  let bad = 0, first = '';
  for (const p of jobs) {
    const r = await compare(p);
    if (!r.ok) { bad++; if (!first) first = `${p.id}: ${r.detail}`; }
  }
  assert(`${jobs.length} random paving jobs reconcile`, bad === 0, `${bad} differ; first ${first}`);

  await c.end();
  console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
