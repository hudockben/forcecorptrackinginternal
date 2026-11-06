#!/usr/bin/env node
'use strict';
/**
 * Custom Reporting — the report engine (custom-reports-engine.js).
 *
 * Run: node scripts/test-custom-reports-engine.js
 *      CR_ENGINE_OUT=dir node scripts/test-custom-reports-engine.js   (also writes the reports out)
 *
 * The engine turns a saved report definition and a division page's data into
 * rows, a printable HTML document and an .xlsx. These reports go to
 * customers, so the suite leans hardest on two things:
 *
 *   - Customer-safe: a locked internal column, or a financial one the role
 *     cannot see, must never reach the HTML or the workbook — not its header
 *     and not its values — even when a saved definition names it. Checked by
 *     scanning the output for both.
 *   - The figures are the page's figures: job-to-date quantities, costs, %
 *     complete, projected cost and contract come out equal to paving.html's
 *     own helpers (lifted with fn-source, as test-bid-xlsx does), and the
 *     engine's fallbacks give the same numbers when a page passes no helpers.
 *
 * The production-rate KPIs (avg / day, best day, days left, Mon–Fri projected
 * finish, units per man-hour, cost per unit) are checked against figures
 * worked out by hand from the fixture below, with "today" pinned.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const { requireFn, fnSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n${t}`);
const near = (a, b, eps = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;
const J = v => JSON.parse(JSON.stringify(v));   // out of the vm's realm

const ROOT   = path.resolve(__dirname, '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8');
const OUT    = process.env.CR_ENGINE_OUT;
const TODAY  = '2026-11-05';                        // a Thursday
const NOW    = new Date(2026, 10, 5, 14, 30);

// ── The engine, alone: a bare vm with only window = globalThis ──
function bareEngine(extra) {
  const ctx = Object.assign({}, extra || {});
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(ENGINE, ctx, { filename: 'custom-reports-engine.js' });
  return ctx;
}

// ── A division page's helpers, lifted, with the engine loaded beside them ──
const LIFT = ['dailyRowCost', 'calcDaily', 'bidItemComplete', '_bidCsKey', 'bidProjectPct', 'bidGroupPct',
  'runningQtyForBidItem', 'actualForBidItem', 'cumulativeHoursForBidItem', 'laborerCountForBidItem',
  '_rowIsWorkDay', '_workDaysForItems', 'projForBidItem', 'projectedCostForProject', 'offBidForProject',
  'projIsDone', 'gpEarnedToDate', 'bidContractFigures', 'getProj', 'getAllDailyRows'];
// Paving quotes its contract through its change-order helpers; the PO line
// math lives where the PO tab does.
const OPTIONAL = ['projectContract', 'originalContract', 'revisedContract', 'contractCOTotal', 'contractCOs',
  '_lineAmt', '_lineTax', '_lineTaxPct', '_poNum', '_poNum0', '_normalizeNumeric',
  '_localDateStr', '_usHolidays', '_isHoliday', '_addWorkingDays', '_poTotals',
  // The Schedule tab's pace math, for planned-rate parity.
  '_workingDaysBetween', '_schedDaysRemaining', '_schedStatus', '_ppWorkingDaysRemaining', '_schedCalcRow'];
function pageEngine(file) {
  const SRC = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const haul = /const HAUL_FIELD_TYPE_RE\s*=\s*([^;]+);/.exec(SRC);
  const ctx = { console };
  vm.createContext(ctx);
  ctx.window = ctx;
  const have = OPTIONAL.filter(n => fnSource(SRC, n));
  vm.runInContext([
    'var projectsList = [];',
    'var pvPreview = { active: false, rate: 0 };',
    'var _bidCsComplete = {};',
    'var _holidayCache = {};',
    'var _pp = null;',
    `var HAUL_FIELD_TYPE_RE = ${haul ? haul[1] : '/^haul\\s*[—–-]\\s/i'};`,
    ...LIFT.concat(have).map(n => requireFn(SRC, n, file)),
  ].join('\n'), ctx, { filename: file });
  vm.runInContext(ENGINE, ctx, { filename: 'custom-reports-engine.js' });
  const fn = n => (typeof ctx[n] === 'function' ? ctx[n] : undefined);
  const helpers = {
    dailyRowCost: fn('dailyRowCost'), calcDaily: fn('calcDaily'), bidItemComplete: fn('bidItemComplete'),
    bidProjectPct: fn('bidProjectPct'), bidGroupPct: fn('bidGroupPct'), projForBidItem: fn('projForBidItem'),
    projectedCostForProject: fn('projectedCostForProject'), gpEarnedToDate: fn('gpEarnedToDate'),
    bidContractFigures: fn('bidContractFigures'), projIsDone: fn('projIsDone'),
    lineAmt: fn('_lineAmt'), lineTax: fn('_lineTax'), addWorkingDays: fn('_addWorkingDays'),
    workingDaysBetween: fn('_workingDaysBetween'),
  };
  return { ctx, helpers, file };
}

// ── The fixture: two real jobs and one hostile one ──
// Internal values are deliberately odd numbers and names so a scan of the
// output finds them if they leak and finds nothing else.
const SECRET = {
  employee: 'Zebediah Quill', rate: '47.13', equipment: 'Mill W200', jobClass: 'Foreman Zed',
  materialCost: '1234.57', supplier: 'Secret Supplier LLC', note: 'SECRET-NOTE-XYZ',
  contract: '251234.56', coAmount: '12345.67', invoiced: '80321.09', retention: '7.25',
  driver: 'Dewey Hauler', truckRate: '95.55', poUnitCost: '61.37', bidUnitCost: '92.25', baseUnitCost: '85.57',
};
function fixture() {
  const S = SECRET;
  const p1 = {
    id: 'p1', 'project-name': 'Route 30 Resurfacing', 'job-number': '26101', status: 'In Progress',
    client: 'Acme Township', gc: 'BuildCo', pm: 'Pat Manager', address: '100 Main St', 'city-state': 'Greensburg, PA',
    'start-date': '2026-10-01', 'end-date': '2026-12-15', 'contract-days': '60', scope: 'Mill and overlay',
    sqft: '5000', 'contract-amount': S.contract, retention: S.retention, invoiced: S.invoiced, notes: S.note,
    'contract-cos': [{ id: 'c1', date: '2026-10-20', number: 'CO-1', amount: S.coAmount, note: 'Added driveway aprons' }],
    bidItems: [
      { id: 'b1', cost_code: 'Paving', sub_code: 'Base Course', description: 'Aggregate base', unit: 'TON', quantity: '2000',
        unit_cost: S.baseUnitCost, change_orders: [{ date: '2026-10-15', number: 'Q-1', qty_delta: '100', note: 'Extra base at entrance' }] },
      { id: 'b2', cost_code: 'Paving', sub_code: 'Surface Course', unit: 'TON', quantity: '600', unit_cost: S.bidUnitCost },
      { id: 'b3', cost_code: 'Milling', sub_code: 'Mill 2in', unit: 'SY', quantity: '5000', unit_cost: '2.4', is_complete: true },
      { id: 'b4', cost_code: 'Striping', sub_code: '', unit: 'LF', quantity: '2000', unit_cost: '0.9' },
      { id: 'b5', cost_code: 'Seeding', sub_code: 'Topsoil', unit: 'SY', quantity: '800', unit_cost: '3',
        start_date: '2026-11-10', target_date: '2026-11-20' },
    ],
    dailyRows: [
      { id: 'r1', date: '2026-10-05', cost_code: 'Milling', sub_code: 'Mill 2in', quantity: '2600', labor_hours: '8', employee: S.employee,
        rate: S.rate, equipment: S.equipment, equip_hours: '8', equip_unit_cost: '210', job_class: S.jobClass, field_type: 'Labor' },
      { id: 'r2', date: '2026-10-06', cost_code: 'Milling', sub_code: 'Mill 2in', quantity: '2400', labor_hours: '8', employee: 'Ann Lee', rate: '38' },
      { id: 'r3', date: '2026-10-27', cost_code: 'Paving', sub_code: 'Base Course', quantity: '200', labor_hours: '10', employee: S.employee, rate: S.rate },
      { id: 'r4', date: '2026-10-27', cost_code: 'Paving', sub_code: 'Base Course', quantity: '100', labor_hours: '10', employee: 'Bob Ray', rate: '40' },
      { id: 'r5', date: '2026-10-28', cost_code: 'Paving', sub_code: 'Base Course', quantity: '250', labor_hours: '9', employee: S.employee, rate: S.rate },
      { id: 'r6', date: '2026-10-30', cost_code: 'Paving', sub_code: 'Base Course', quantity: '150', labor_hours: '8', employee: 'Bob Ray', rate: '40',
        material: 'Asphalt base', material_cost: S.materialCost, supplier: S.supplier, po_num: 'PO-9' },
      { id: 'r7', date: '2026-11-02', cost_code: 'Paving', sub_code: 'Base Course', quantity: '350', labor_hours: '10', employee: S.employee, rate: S.rate },
      // A work day by hours alone: counts as a day, adds no quantity.
      { id: 'r8', date: '2026-11-03', cost_code: 'Paving', sub_code: 'Base Course', quantity: '0', labor_hours: '4', employee: 'Bob Ray', rate: '40' },
      { id: 'r9', date: '2026-11-04', cost_code: 'Paving', sub_code: 'Surface Course', quantity: '120', labor_hours: '8', employee: 'Ann Lee', rate: '38' },
      // A cost-code-only bid line takes every sub code under it.
      { id: 'r10', date: '2026-11-04', cost_code: 'Striping', sub_code: 'Layout', quantity: '500', labor_hours: '6', employee: 'Cal Dunn', rate: '30' },
      { id: 'r11', date: '2026-11-04', cost_code: 'Striping', sub_code: 'Paint', quantity: '300', labor_hours: '2', employee: 'Cal Dunn', rate: '30' },
      // Off-bid spend, imported with its own total: in the job's cost, on no line.
      { id: 'r12', date: '2026-10-29', cost_code: 'Mobilization', sub_code: '', quantity: '0', total_cost: '777.77' },
      // Undated: part of the job to date, in no period.
      { id: 'r13', date: '', cost_code: 'Paving', sub_code: 'Base Course', quantity: '0', material_cost: '55' },
    ],
  };
  const p2 = {
    id: 'p2', 'project-name': 'Elm Street Lot', 'job-number': '26102', status: 'In Progress', client: 'Beta Corp',
    'contract-value': '50000',
    bidItems: [
      { id: 'e1', cost_code: 'Paving', sub_code: 'Surface Course', unit: 'TON', quantity: '300', unit_cost: '95' },
      { id: 'e2', cost_code: 'Sealcoat', sub_code: '', unit: 'SY', quantity: '4000', unit_cost: '0.5' },
    ],
    dailyRows: [
      { id: 's1', date: '2026-11-02', cost_code: 'Paving', sub_code: 'Surface Course', quantity: '100', labor_hours: '6', employee: 'Dee Fox', rate: '35' },
      { id: 's2', date: '2026-11-03', cost_code: 'Paving', sub_code: 'Surface Course', quantity: '80', labor_hours: '6', employee: 'Dee Fox', rate: '35' },
      { id: 's3', date: '2026-11-03', cost_code: 'Sealcoat', sub_code: 'Coat', quantity: '1500', labor_hours: '4', employee: 'Eve Gray', rate: '30' },
    ],
  };
  const p3 = {
    id: 'p3', 'project-name': '<img src=x onerror=alert(1)>', 'job-number': '"><b>9</b>', client: '"><script>alert(2)</script>',
    status: 'In Progress',
    bidItems: [{ id: 'x1', cost_code: '<b>CC</b>', sub_code: "O'Brien & Sons", unit: 'EA', quantity: '1', unit_cost: '1' }],
    dailyRows: [{ id: 'x1r', date: '2026-11-02', cost_code: '<b>CC</b>', sub_code: "O'Brien & Sons", quantity: '1', labor_hours: '1' }],
  };
  const pos = [
    { id: 'po1', po_number: 'PO-1001', title: 'Hot Mix Base', supplier: 'Hot Mix Inc', status: 'approved', project_id: 'p1',
      cost_code: 'Paving', sub_code: 'Base Course', lines: [
        { id: 'l1', date: '2026-10-27', invoice_num: 'T-501', qty: '22.5', unit_cost: SECRET.poUnitCost, tax_pct: '6' },
        { id: 'l2', date: '2026-10-28', invoice_num: 'T-502', qty: '20', unit_cost: SECRET.poUnitCost, tax_pct: '6' },
        { id: 'l3', date: '2026-09-01', invoice_num: 'T-400', qty: '10', unit_cost: SECRET.poUnitCost, tax: '5' },
        // The blank line the PO tab adds with every new order.
        { id: 'l4', date: '2026-11-05', invoice_num: '', qty: '', unit_cost: '', tax: '', tax_pct: '' },
      ] },
    { id: 'po2', po_number: 'PO-2001', title: 'Tack Coat', supplier: 'Tack Co', status: 'pending', project_id: 'p2',
      lines: [{ id: 'l5', date: '2026-11-03', invoice_num: 'TK-1', qty: '150', unit_cost: '3.1', tax: '10' }] },
    { id: 'po3', po_number: 'PO-3001', title: 'Other job', supplier: 'Nobody', project_id: 'zz',
      lines: [{ id: 'l6', date: '2026-11-03', invoice_num: 'Z-1', qty: '5', unit_cost: '1' }] },
  ];
  const trucks = [
    { id: 't1', tr_number: 'TR-0001', driver: SECRET.driver, truck_type: 'Tri-axle', project_id: 'p1', date: '2026-10-27',
      material_hauled: 'Millings', loads: '6', rate: SECRET.truckRate, hours: '7.5', status: 'approved', notes: 'Gate code 4411',
      cost_code: 'Milling', sub_code: 'Mill 2in' },
    { id: 't2', tr_number: 'TR-0002', driver: 'Old Driver', truck_type: 'Quad', project_id: 'p1', date: '2026-09-15',
      material_hauled: 'Stone', loads: '3', rate: '80', hours: '4', status: 'approved' },
    { id: 't3', tr_number: 'TR-0003', driver: 'Elsewhere', truck_type: 'Quad', project_id: 'zz', date: '2026-10-27',
      material_hauled: 'Stone', loads: '9', rate: '80', hours: '4' },
  ];
  return { projects: [p1, p2, p3], pos, trucks };
}

function cfgFor(env, data, extra) {
  return Object.assign({
    division: 'paving', divisionLabel: 'Paving', areaUnit: 'SY',
    perm: { role: 'admin', canSeeCosts: true, canSeeFinancials: true, canShare: true },
    getProjects: () => data.projects, getPurchaseOrders: () => data.pos, getTruckingEntries: () => data.trucks,
    helpers: env.helpers,
  }, extra || {});
}

// A definition naming EVERY column of every section — the shape a shared
// template or a hand-edited payload could carry.
function allColumnsDef(E, extra) {
  const sections = E.SECTION_ORDER.map(t => {
    const s = E.newSection(t);
    s.columns = E.CATALOG[t].columns.map(c => c.key);
    if (t === 'notes') s.text = 'Thanks for your business.';
    if (t === 'daily_production') s.options.summarize = false;
    return s;
  });
  return E.normalizeDefinition(Object.assign({ title: 'Everything', sections }, extra || {}));
}

// ── XLSX reading, the way Excel reads a stored ZIP (from test-bid-xlsx.js) ──
function unzip(buf) {
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdAt = buf.readUInt32LE(eocd + 16);
  if (cdAt + cdSize !== eocd) throw new Error('central directory does not end at the EOCD');
  const out = {};
  let at = cdAt;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} has a bad signature`);
    const crc = buf.readUInt32LE(at + 16), size = buf.readUInt32LE(at + 20), nlen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nlen).toString('utf8');
    at += 46 + nlen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: no local header`);
    if (buf.readUInt32LE(local + 14) !== crc || buf.readUInt32LE(local + 18) !== size) throw new Error(`${name}: local header disagrees`);
    const dataAt = local + 30 + nlen + buf.readUInt16LE(local + 28);
    const data = buf.slice(dataAt, dataAt + size);
    if (zlib.crc32(data) !== crc) throw new Error(`${name}: CRC-32 does not match`);
    out[name] = data.toString('utf8');
  }
  return out;
}
const xmlDoc = xml => new JSDOM(xml, { contentType: 'text/xml' }).window.document;
const toBuf = u8 => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
function readSheet(xml) {
  const doc = xmlDoc(xml), cells = {};
  for (const c of doc.getElementsByTagName('c')) {
    const v = c.getElementsByTagName('v')[0], t = c.getElementsByTagName('t')[0], type = c.getAttribute('t');
    cells[c.getAttribute('r')] = { s: +(c.getAttribute('s') || 0), t: type,
      v: type === 'inlineStr' ? (t ? t.textContent : '') : v ? +v.textContent : null };
  }
  return cells;
}
function readStyles(xml) {
  const doc = xmlDoc(xml), fmts = {};
  for (const n of doc.getElementsByTagName('numFmt')) fmts[n.getAttribute('numFmtId')] = n.getAttribute('formatCode');
  return [...doc.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf')].map(x => fmts[x.getAttribute('numFmtId')] || null);
}
function workbook(u8) {
  const parts = unzip(toBuf(u8));
  const bad = Object.entries(parts).filter(([, x]) => xmlDoc(x).getElementsByTagName('parsererror').length).map(([n]) => n);
  const wbDoc = xmlDoc(parts['xl/workbook.xml']);
  const names = [...wbDoc.getElementsByTagName('sheet')].map(s => s.getAttribute('name'));
  const sheets = {};
  names.forEach((n, i) => { sheets[n] = readSheet(parts[`xl/worksheets/sheet${i + 1}.xml`]); });
  return { parts, bad, names, sheets, styles: readStyles(parts['xl/styles.xml']) };
}
// Find a header cell's column letter and row in a sheet.
function findCell(cells, value) {
  const ref = Object.keys(cells).find(r => cells[r].v === value);
  return ref ? { col: ref.replace(/\d+/g, ''), row: +ref.replace(/\D+/g, '') } : null;
}
const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;

function save(name, data) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : toBuf(data));
}

// Cells of one section, as plain data: [{ job, label, rows: [cells], subtotal }].
function flat(sd) {
  return J(sd.blocks.map(b => ({ job: b.job ? b.job.id : null, totals: b.totals,
    groups: b.groups.map(g => ({ label: g.label, rows: g.rows.map(r => r.cells), subtotal: g.subtotal })) })));
}
function rowsOf(sd, jobIdx = 0) {
  const b = sd.blocks[jobIdx];
  return b ? J(b.groups.flatMap(g => g.rows.map(r => r.cells))) : [];
}
function deepNear(a, b, at = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) ? null : `${at}: ${a} vs ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { const d = deepNear(a[k], b[k], at + '.' + k); if (d) return d; }
  return null;
}

(async () => {
  const bare = bareEngine();
  const E = bare.FCTReportEngine;

  // ────────────────────────────────────────────────────────────────────────
  section('API surface');
  const API = ['VERSION', 'CATALOG', 'SECTION_ORDER', 'STARTERS', 'DATE_PRESETS', 'defaultDefinition', 'newSection',
    'normalizeDefinition', 'resolveDateRange', 'resolveJobs', 'columnState', 'effectiveColumns', 'hiddenFinancialCount',
    'hasInternal', 'costCodesFor', 'makeContext', 'buildSectionData', 'buildReportHtml', 'buildXlsx', 'xlsxFileName',
    'formatCell', 'escHtml', 'subCodesFor', 'countWorkdays', 'normUnit', 'startersFor', 'aiCatalog'];
  assert('window.FCTReportEngine exposes every member of the contract', API.every(k => k in E), API.filter(k => !(k in E)).join(', '));
  assert('VERSION is 2', E.VERSION === 2);
  assert('loads in a bare vm: no fetch, document, TextEncoder or Blob needed',
    typeof bare.document === 'undefined' && typeof bare.fetch === 'undefined' && typeof bare.TextEncoder === 'undefined');
  assert('engine source never reaches for the DOM or the network',
    !/\b(document|fetch|XMLHttpRequest|localStorage)\s*[.(]/.test(ENGINE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  const again = bareEngine({ FCTReportEngine: { marker: 1 } });
  assert('loading twice keeps the first copy', again.FCTReportEngine.marker === 1);

  // ────────────────────────────────────────────────────────────────────────
  section('Catalog');
  const TYPES = ['text', 'number', 'qty', 'money', 'date', 'percent', 'days'];
  const allTypes = Object.keys(E.CATALOG);
  assert('thirteen section types (v2 adds plan_vs_actual, chart, rate_summary), in the + Add section order',
    allTypes.length === 13 && E.SECTION_ORDER.length === 13 && E.SECTION_ORDER.every(t => E.CATALOG[t])
      && JSON.stringify(E.SECTION_ORDER.slice(-4)) === JSON.stringify(['plan_vs_actual', 'chart', 'rate_summary', 'notes']));
  let colProblems = [];
  allTypes.forEach(t => {
    const cat = E.CATALOG[t];
    if (cat.type !== t || !cat.label || !cat.blurb || typeof cat.table !== 'boolean') colProblems.push(`${t}: header`);
    const keys = new Set();
    cat.columns.forEach(c => {
      if (!c.key || !c.label || !TYPES.includes(c.type)) colProblems.push(`${t}.${c.key}: key/label/type`);
      if (typeof c.internal !== 'boolean' || typeof c.financial !== 'boolean' || typeof c.def !== 'boolean') colProblems.push(`${t}.${c.key}: flags`);
      if (c.financial && !c.internal) colProblems.push(`${t}.${c.key}: financial but not internal`);
      if (c.def && c.internal) colProblems.push(`${t}.${c.key}: an internal column on by default`);
      if (c.total !== null && c.total !== 'sum') colProblems.push(`${t}.${c.key}: total`);
      if (keys.has(c.key)) colProblems.push(`${t}.${c.key}: duplicate`);
      keys.add(c.key);
    });
    const specKeys = cat.optionSpec.map(o => o.key).sort().join(',');
    if (specKeys !== Object.keys(cat.options).sort().join(',')) colProblems.push(`${t}: optionSpec ≠ options`);
    cat.optionSpec.forEach(o => {
      if (!['select', 'bool', 'costCodes', 'subCodes', 'kinds'].includes(o.kind) || !o.label) colProblems.push(`${t}.${o.key}: spec`);
      if (o.kind === 'select' && !o.choices.some(c => c[0] === cat.options[o.key])) colProblems.push(`${t}.${o.key}: default not a choice`);
    });
  });
  assert('every column has key, label, a known type, boolean flags; financial ⇒ internal; nothing internal on by default',
    !colProblems.length, colProblems.join('; '));
  const flagged = (t, k) => E.CATALOG[t].columns.find(c => c.key === k);
  const MUST_INTERNAL = { bid_progress: ['unit_cost', 'bid_total', 'actual_cost', 'variance', 'projected_cost', 'labor_hours', 'crew_size', 'cost_per_unit', 'units_per_mh'],
    daily_production: ['employee', 'job_class', 'labor_hours', 'rate', 'labor_cost', 'equipment', 'equip_hours', 'equip_cost', 'material', 'supplier', 'po_num', 'material_cost', 'total_cost'],
    production_kpis: ['labor_hours', 'units_per_mh', 'cost_per_unit', 'crew_avg'],
    summary_kpis: ['labor_hours', 'actual_cost', 'period_cost', 'bid_budget', 'projected_cost', 'contract', 'co_total', 'gp_earned'],
    job_info: ['notes', 'contract', 'retention', 'invoiced'], materials: ['unit_cost', 'tax', 'line_total'],
    trucking: ['driver', 'hours', 'rate', 'cost'], change_orders: ['amount'] };
  const MUST_FIN = { job_info: ['contract', 'retention', 'invoiced'], summary_kpis: ['contract', 'co_total', 'gp_earned'], change_orders: ['amount'] };
  const miss = [];
  Object.entries(MUST_INTERNAL).forEach(([t, ks]) => ks.forEach(k => { const c = flagged(t, k); if (!c || !c.internal) miss.push(`${t}.${k}`); }));
  assert('costs, rates, wages, hours, employee names and contract $ are all internal', !miss.length, miss.join(', '));
  const finMiss = [];
  Object.entries(MUST_FIN).forEach(([t, ks]) => ks.forEach(k => { const c = flagged(t, k); if (!c || !c.financial) finMiss.push(`${t}.${k}`); }));
  const finCount = allTypes.reduce((n, t) => n + E.CATALOG[t].columns.filter(c => c.financial).length, 0);
  assert('contract and profit figures — and only those — are financial', !finMiss.length && finCount === 7, finMiss.join(', ') + ` (${finCount})`);
  assert('the spec\'s default columns', JSON.stringify(E.newSection('bid_progress').columns)
      === JSON.stringify(['cost_code', 'sub_code', 'unit', 'bid_qty', 'installed_to_date', 'remaining_qty', 'pct_complete', 'status'])
    && JSON.stringify(E.newSection('production_kpis').columns)
      === JSON.stringify(['sub_code', 'unit', 'qty_period', 'days_period', 'avg_per_day', 'remaining_qty', 'est_days_left', 'projected_finish'])
    && JSON.stringify(E.newSection('daily_production').columns) === JSON.stringify(['date', 'cost_code', 'sub_code', 'quantity', 'unit'])
    && JSON.stringify(E.newSection('job_info').columns)
      === JSON.stringify(['project-name', 'job-number', 'client', 'gc', 'address', 'city-state', 'start-date', 'end-date', 'pct_complete']));
  assert('DATE_PRESETS: the ten presets', JSON.stringify(E.DATE_PRESETS.map(p => p.key)) === JSON.stringify(
    ['job_to_date', 'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7', 'last_30', 'custom'])
    && E.DATE_PRESETS.every(p => p.label));

  // ────────────────────────────────────────────────────────────────────────
  section('Definitions');
  const blank = E.defaultDefinition();
  assert('defaultDefinition is a blank v2: no sections, jobs picked at run time, customer-safe, no filters, company branding',
    blank.v === 2 && blank.sections.length === 0 && blank.jobs.mode === 'pick' && blank.jobs.ids.length === 0
      && blank.includeInternal === false && blank.layout === 'separate' && blank.dates.preset === 'job_to_date'
      && blank.header.showGenerated === true && JSON.stringify(blank.filters) === '{"costCodes":[],"subCodes":[]}'
      && blank.header.branding === 'company' && blank.header.showPmContact === true
      && blank.header.contactName === '' && blank.header.contactPhone === '' && blank.header.contactEmail === '' && !('description' in blank));
  const s1 = E.newSection('trucking'), s2 = E.newSection('trucking');
  assert('newSection: fresh ids, default title / columns / options; notes carry text; unknown type → null',
    s1.id !== s2.id && s1.title === 'Trucking / Haul Log' && J(s1.options).totals === true
      && E.newSection('notes').text === '' && !('text' in s1) && E.newSection('bogus') === null);
  assert('normalizeDefinition(null) is the blank definition', JSON.stringify(E.normalizeDefinition(null)) === JSON.stringify(blank));
  const junkNotes = Array.from({ length: 25 }, () => ({ type: 'notes', text: 'x'.repeat(6000), id: 'dup' }));
  const junk = E.normalizeDefinition({
    v: 7, title: 12345, includeInternal: 'true', layout: 'diagonal', orientation: 'landscape', header: 'junk',
    dates: { preset: 'fortnight', from: '2026-02-30', to: 'soon' }, jobs: ['a', 'a', 3, null, {}, NaN],
    sections: [{ type: 'bogus' }, { type: ['job_info'] }, 'str', null,
      { type: 'bid_progress', id: 'bp<1>', columns: ['cost_code', 'nope', 5, 'cost_code', 'actual_cost'],
        labels: { cost_code: '  Code  ', nope: 'x', unit: '   ' },
        options: { groupBy: 'weird', totals: 'yes', subtotals: false, costCodes: ['A', 5, 'A', ''] } },
      { type: 'job_info' }].concat(junkNotes),
  });
  const bp = junk.sections[0];
  assert('junk in: v2 out, includeInternal only when literally true', junk.v === 2 && junk.includeInternal === false
    && junk.layout === 'separate' && junk.orientation === 'landscape' && junk.title === '12345');
  assert('unknown section types dropped, sections capped at 20, order kept',
    junk.sections.length === 20 && bp.type === 'bid_progress' && junk.sections[1].type === 'job_info');
  assert('unknown / duplicate column keys dropped, chosen order kept',
    JSON.stringify(bp.columns) === JSON.stringify(['cost_code', 'actual_cost']));
  assert('labels: known keys only, trimmed, blanks dropped', JSON.stringify(bp.labels) === JSON.stringify({ cost_code: 'Code' }));
  assert('options: bad values fall back to defaults, good ones kept',
    bp.options.groupBy === 'cost_code' && bp.options.totals === true && bp.options.subtotals === false
      && JSON.stringify(bp.options.costCodes) === JSON.stringify(['A']));
  assert('a section without columns gets the defaults', junk.sections[1].columns.join() === E.newSection('job_info').columns.join());
  assert('notes text capped at 5000; section ids made valid and unique',
    junk.sections[2].text.length === 5000 && new Set(junk.sections.map(s => s.id)).size === 20
      && junk.sections.every(s => /^[A-Za-z0-9_-]{1,40}$/.test(s.id)));
  assert('bad dates and presets fall back; old array-of-ids jobs read as saved jobs, deduped',
    junk.dates.preset === 'job_to_date' && junk.dates.from === '' && junk.dates.to === ''
      && junk.jobs.mode === 'saved' && JSON.stringify(junk.jobs.ids) === JSON.stringify(['a', 3]));
  assert('header junk → defaults', JSON.stringify(junk.header) === JSON.stringify(blank.header));
  assert('normalizing twice changes nothing', JSON.stringify(E.normalizeDefinition(junk)) === JSON.stringify(junk));

  assert('ten starter templates (the seven, then Planned vs Actual, Sub-Code Production, Paving Tonnage), each already normalized',
    E.STARTERS.length === 10 && E.STARTERS.every(s => s.id && s.name && s.blurb
      && JSON.stringify(E.normalizeDefinition(s.definition)) === JSON.stringify(s.definition))
      && E.STARTERS.map(s => s.id).join() === 'customer_progress,quantities_installed,production_rates,materials_delivered,haul_log,'
        + 'change_order_log,internal_cost_snapshot,planned_vs_actual,sub_code_production,paving_tonnage');
  assert('only the Internal Cost Snapshot is internal',
    E.STARTERS.filter(s => s.internal).map(s => s.id).join() === 'internal_cost_snapshot'
      && E.STARTERS.every(s => s.internal === s.definition.includeInternal));
  const starter = id => E.STARTERS.find(s => s.id === id).definition;
  assert('starters carry the spec\'s sections and dates',
    starter('customer_progress').sections.map(s => s.type).join() === 'job_info,summary_kpis,bid_progress,schedule,notes'
      && starter('customer_progress').sections[1].columns.join() === 'pct_complete,days_worked,items_complete'
      && starter('quantities_installed').dates.preset === 'last_week'
      && starter('quantities_installed').sections[1].columns.join() === 'date,cost_code,sub_code,quantity,unit'
      && starter('production_rates').dates.preset === 'last_30'
      && starter('internal_cost_snapshot').sections[1].columns.includes('variance'));
  const custCfg = { perm: { canSeeFinancials: true } };
  assert('every customer starter is customer-safe, the internal one is not',
    E.STARTERS.every(s => E.hasInternal(s.definition, custCfg.perm) === s.internal));

  // ────────────────────────────────────────────────────────────────────────
  section('Dates');
  const R = (preset, today, extra) => J(E.resolveDateRange(Object.assign({ preset }, extra || {}), today));
  const eq = (r, from, to, label) => r.from === from && r.to === to && (label === undefined || r.label === label);
  assert('job to date: open both ends', eq(R('job_to_date', TODAY), '', '', 'Job to date'));
  assert('today / yesterday', eq(R('today', TODAY), TODAY, TODAY, 'Nov 5, 2026') && eq(R('yesterday', TODAY), '2026-11-04', '2026-11-04'));
  assert('this week runs Monday to Sunday', eq(R('this_week', TODAY), '2026-11-02', '2026-11-08', 'Nov 2 – Nov 8, 2026'));
  assert('…on a Sunday it is still the week that started Monday', eq(R('this_week', '2026-11-08'), '2026-11-02', '2026-11-08')
    && eq(R('this_week', '2026-11-09'), '2026-11-09', '2026-11-15'));
  assert('last week', eq(R('last_week', TODAY), '2026-10-26', '2026-11-01', 'Oct 26 – Nov 1, 2026'));
  assert('this month / last month', eq(R('this_month', TODAY), '2026-11-01', '2026-11-30')
    && eq(R('last_month', TODAY), '2026-10-01', '2026-10-31', 'Oct 1 – Oct 31, 2026'));
  assert('last 7 / last 30 days, today included', eq(R('last_7', TODAY), '2026-10-30', TODAY) && eq(R('last_30', TODAY), '2026-10-07', TODAY));
  assert('across a year end', eq(R('this_week', '2026-01-02'), '2025-12-29', '2026-01-04', 'Dec 29, 2025 – Jan 4, 2026')
    && eq(R('last_month', '2026-01-02'), '2025-12-01', '2025-12-31') && eq(R('last_week', '2026-01-02'), '2025-12-22', '2025-12-28'));
  assert('February in a leap year', eq(R('last_month', '2028-03-10'), '2028-02-01', '2028-02-29'));
  assert('custom: reversed ends swapped, open ends worded',
    eq(R('custom', TODAY, { from: '2026-11-03', to: '2026-10-01' }), '2026-10-01', '2026-11-03')
      && R('custom', TODAY, { from: '2026-10-01', to: '' }).label === 'Since Oct 1, 2026'
      && R('custom', TODAY, { from: 'nope', to: '2026-10-31' }).label === 'Through Oct 31, 2026');

  // ────────────────────────────────────────────────────────────────────────
  section('Jobs');
  const data = fixture();
  const rj = J(E.resolveJobs({ jobs: { mode: 'saved', ids: ['p2', 'gone', 'p1', 'p2'] } }, data.projects));
  assert('resolveJobs keeps the picked order, drops repeats, reports missing ids',
    rj.jobs.map(p => p.id).join() === 'p2,p1' && JSON.stringify(rj.missing) === '["gone"]');
  assert('pickedIds override the saved ids', J(E.resolveJobs({ jobs: { ids: ['p1'] } }, data.projects, ['p3'])).jobs.map(p => p.id).join() === 'p3');
  assert('numeric ids match string ids', J(E.resolveJobs({}, [{ id: 7 }], ['7'])).jobs.length === 1);
  assert('costCodesFor: sorted, distinct, across jobs', JSON.stringify(E.costCodesFor(data.projects.slice(0, 2)))
    === JSON.stringify(['Milling', 'Paving', 'Sealcoat', 'Seeding', 'Striping']));

  // ────────────────────────────────────────────────────────────────────────
  section('Formatting');
  const F = E.formatCell;
  assert('qty: thousands, up to 2 decimals', F(1556, 'qty') === '1,556' && F(1234.5, 'qty') === '1,234.5' && F(12.345, 'qty') === '12.35'
    && F(0, 'qty') === '0' && F(-1500, 'qty') === '-1,500' && F(1234567.891, 'number') === '1,234,567.89');
  assert('money: $1,234.56', F(1234.56, 'money') === '$1,234.56' && F(-1234.5, 'money') === '-$1,234.50' && F(0, 'money') === '$0.00');
  assert('percent: 1 decimal', F(55.123, 'percent') === '55.1%' && F(100, 'percent') === '100.0%');
  assert('dates: Oct 5, 2026', F('2026-10-05', 'date') === 'Oct 5, 2026');
  assert('empty → —', F(null, 'qty') === '—' && F('', 'text') === '—' && F(undefined, 'date') === '—' && F(NaN, 'money') === '—');
  assert('a word in a numeric column is its own text', F('Multiple', 'money') === 'Multiple');
  assert('escHtml escapes & < > " \' and = (the email sanitizer\'s on…= rule never sees running text)',
    E.escHtml(`<a href="x">'&'</a>`) === '&lt;a href&#61;&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;' && E.escHtml('one = 1') === 'one &#61; 1');

  // ────────────────────────────────────────────────────────────────────────
  // Every division page passes its own helpers; the figures must be theirs.
  for (const file of ['paving.html', 'tracker.html', 'kiewit-pinetree.html']) {
    section(`Job-to-date figures equal ${file}'s own helpers`);
    const env = pageEngine(file);
    const PE = env.ctx.FCTReportEngine;
    const d = fixture();
    env.ctx.projectsList = d.projects;
    const def = allColumnsDef(PE, { includeInternal: true });
    const ctx = PE.makeContext(def, cfgFor(env, d), { pickedIds: ['p1', 'p2'], today: TODAY, now: NOW });
    const byType = t => def.sections.find(s => s.type === t);
    const bpData = PE.buildSectionData(byType('bid_progress'), def, ctx);
    const page = env.ctx;
    let bad = [];
    ['p1', 'p2'].forEach((id, ji) => {
      const p = d.projects.find(x => x.id === id);
      const rows = rowsOf(bpData, ji);
      p.bidItems.forEach((b, i) => {
        const r = rows[i];
        const bidQty = parseFloat(b.quantity) + (b.change_orders || []).reduce((s, co) => s + parseFloat(co.qty_delta), 0);
        const actual = page.actualForBidItem(b, id), rq = page.runningQtyForBidItem(b, id);
        const want = {
          installed_to_date: rq, actual_cost: actual, labor_hours: page.cumulativeHoursForBidItem(b, id),
          crew_size: page.laborerCountForBidItem(b, id), days_worked: page._workDaysForItems([b], id).length,
          projected_cost: page.projForBidItem(b, actual, rq, bidQty, bidQty * parseFloat(b.unit_cost),
            page.projIsDone(p) || page.bidItemComplete(b, id)),
          pct_complete: page.bidGroupPct([b], id).pct,
        };
        Object.entries(want).forEach(([k, v]) => { if (!near(r[k], v)) bad.push(`${id}/${b.id}.${k}: ${r[k]} vs ${v}`); });
      });
    });
    assert('installed, actual, hours, crew, days, projected cost and % per bid item', !bad.length, bad.slice(0, 4).join('; '));
    const groups = bpData.blocks[0].groups;
    const paving = groups.find(g => g.label === 'Paving');
    const pavingItems = d.projects[0].bidItems.filter(b => b.cost_code === 'Paving');
    assert('a cost code\'s subtotal % is the page\'s bidGroupPct', paving && near(paving.subtotal.pct_complete, page.bidGroupPct(pavingItems, 'p1').pct),
      paving && `${paving.subtotal.pct_complete} vs ${page.bidGroupPct(pavingItems, 'p1').pct}`);
    const sk = rowsOf(PE.buildSectionData(byType('summary_kpis'), def, ctx), 0)[0];
    const p1 = d.projects[0];
    const actualAll = p1.dailyRows.reduce((s, r) => s + page.dailyRowCost(r), 0);
    const proj = page.projectedCostForProject(p1), con = page.bidContractFigures(p1);
    const gp = page.gpEarnedToDate(con.value, actualAll, proj);
    assert('summary: % complete is bidProjectPct, actual is every daily cost (off-bid included)',
      near(sk.pct_complete, page.bidProjectPct('p1').pct) && near(sk.actual_cost, actualAll) && near(actualAll, 7219.15, 1e-6),
      `${sk.pct_complete} / ${sk.actual_cost}`);
    assert('summary: projected cost, contract and GP earned are the page\'s',
      near(sk.projected_cost, proj) && near(sk.contract, con.value) && near(sk.gp_earned, gp ? gp.gp : null),
      `${sk.projected_cost} vs ${proj}; ${sk.contract} vs ${con.value}`);
    assert(file === 'paving.html' ? 'paving: the contract includes its contract change order' : 'no contract COs on this page: the contract is typed',
      file === 'paving.html' ? near(sk.contract, 251234.56 + 12345.67) && near(sk.co_total, 12345.67) : near(sk.contract, 251234.56));
    const ji = rowsOf(PE.buildSectionData(byType('job_info'), def, ctx), 0)[0];
    assert('job card: days worked counts distinct work days (an hours-only day counts, a delivery-only day does not)',
      ji.days_worked === 8 && near(ji.pct_complete, page.bidProjectPct('p1').pct));

    // The same report with NO helpers: the engine's own math must agree.
    if (file === 'paving.html') {
      section('No helpers: the fallbacks give the same numbers');
      const noH = bareEngine();
      const NE = noH.FCTReportEngine;
      for (const layout of ['separate', 'combined']) {
        for (const preset of ['job_to_date', 'last_30', 'last_week']) {
          const dd = J(Object.assign({}, def, { layout, dates: { preset, from: '', to: '' } }));
          const c1 = PE.makeContext(dd, cfgFor(env, d), { pickedIds: ['p1', 'p2'], today: TODAY, now: NOW });
          const c2 = NE.makeContext(dd, cfgFor({ helpers: undefined }, d), { pickedIds: ['p1', 'p2'], today: TODAY, now: NOW });
          const diffs = dd.sections.map(s => deepNear(flat(PE.buildSectionData(s, dd, c1)), flat(NE.buildSectionData(s, dd, c2)), s.type)).filter(Boolean);
          assert(`${layout}, ${preset}: every section's cells match`, !diffs.length, diffs.slice(0, 3).join('; '));
        }
      }
      const h1 = PE.buildReportHtml(def, PE.makeContext(def, cfgFor(env, d), { pickedIds: ['p1', 'p2'], today: TODAY, now: NOW }));
      const h2 = NE.buildReportHtml(def, NE.makeContext(def, cfgFor({}, d), { pickedIds: ['p1', 'p2'], today: TODAY, now: NOW }));
      assert('…and the printed reports are identical', h1 === h2, `${h1.length} vs ${h2.length}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // From here on: paving's helpers, as the page passes them.
  const env = pageEngine('paving.html');
  const PE = env.ctx.FCTReportEngine;
  const d0 = fixture();
  env.ctx.projectsList = d0.projects;
  const mk = (def, ids, extra, cfgExtra) => PE.makeContext(def, cfgFor(env, d0, cfgExtra), Object.assign({ pickedIds: ids, today: TODAY, now: NOW }, extra || {}));
  const one = (type, patch, defPatch) => {
    const s = Object.assign(PE.newSection(type), patch || {});
    if (patch && patch.options) s.options = Object.assign(PE.newSection(type).options, patch.options);
    return PE.normalizeDefinition(Object.assign({ title: 'T', sections: [s] }, defPatch || {}));
  };

  section('Production rates — worked by hand');
  {
    // Last 30 days = Oct 7 – Nov 5. Base Course: 200+100 (Oct 27), 250, 150,
    // 350, 0 (Nov 3, 4 h) = 1,050 TON on 5 work days → 210 / day. Best day
    // Nov 2 (350) over Oct 27 (300). Bid 2,000 + CO 100 = 2,100, installed
    // 1,050 → 1,050 left ÷ 210 = exactly 5 days. Thu Nov 5 + 5 workdays →
    // Fri 6, Mon 9, Tue 10, (Wed 11 is Veterans Day) Thu 12, Fri 13.
    const def = one('production_kpis', { columns: PE.CATALOG.production_kpis.columns.map(c => c.key), options: { totals: true } },
      { dates: { preset: 'last_30' }, includeInternal: true });
    const sd = PE.buildSectionData(def.sections[0], def, mk(def, ['p1']));
    const rows = rowsOf(sd);
    const base = rows.find(r => r.sub_code === 'Base Course'), surf = rows.find(r => r.sub_code === 'Surface Course');
    const strp = rows.find(r => r.cost_code === 'Striping');
    assert('only bid items worked in the period are listed (Milling was Oct 5–6, Seeding not started)',
      rows.length === 3 && !rows.some(r => r.cost_code === 'Milling' || r.cost_code === 'Seeding'), rows.map(r => r.sub_code).join());
    assert('Base Course: 1,050 TON over 5 work days (the hours-only day counts), undated row left out',
      base.qty_period === 1050 && base.days_period === 5);
    assert('avg / day = 210, best day = 350', base.avg_per_day === 210 && base.best_day === 350);
    assert('remaining 1,050 ÷ 210 → est. days left 5', base.remaining_qty === 1050 && base.est_days_left === 5);
    assert('projected finish Fri Nov 13 (over a weekend and Veterans Day, as the pages count)', base.projected_finish === '2026-11-13', base.projected_finish);
    assert('units per man-hour = 1,050 ÷ 51 h', near(base.labor_hours, 51) && near(base.units_per_mh, 1050 / 51));
    // 471.30 + 400 + 424.17 + (320 + 1,234.57 material) + 471.30 + 160
    assert('cost per unit = $3,481.34 ÷ 1,050', near(base.cost_per_unit, 3481.34 / 1050), base.cost_per_unit);
    assert('avg crew = (2 + 1 + 1 + 1 + 1) ÷ 5 days = 1.2', near(base.crew_avg, 1.2));
    // Oct 28 – Nov 3 starts after the two-man day: four days of one man each.
    // Averaging over every day worked to date instead would give 4 ÷ 5.
    const midDef = one('production_kpis', { columns: ['sub_code', 'days_period', 'crew_avg'] },
      { dates: { preset: 'custom', from: '2026-10-28', to: '2026-11-03' }, includeInternal: true });
    const mid = rowsOf(PE.buildSectionData(midDef.sections[0], midDef, mk(midDef, ['p1']))).find(r => r.sub_code === 'Base Course');
    assert('avg crew counts only the period\'s work days: 4 ÷ 4 = 1.0', mid.days_period === 4 && near(mid.crew_avg, 1), J(mid));
    assert('Surface Course: 120 in a day, 480 left → 4 days → Thu Nov 12 (Veterans Day skipped)',
      surf.avg_per_day === 120 && surf.remaining_qty === 480 && surf.est_days_left === 4 && surf.projected_finish === '2026-11-12');
    assert('a cost-code-only line takes both sub codes: 800 LF, 1,200 left → ceil(1.5) = 2 → Mon Nov 9',
      strp.qty_period === 800 && strp.best_day === 800 && strp.est_days_left === 2 && strp.projected_finish === '2026-11-09');
    const tot = sd.blocks[0].totals;
    assert('totals: mixed units listed per unit, days across lines distinct, finish = the last line\'s',
      tot.qty_period === '1,170 TON · 800 LF' && tot.days_period === 6 && tot.est_days_left === 5
        && tot.projected_finish === '2026-11-13' && tot.avg_per_day === null && near(tot.labor_hours, 51 + 8 + 8), J(tot));

    // A finished line has nothing left and no finish date; Friday + 1 is Monday.
    const fri = PE.buildSectionData(def.sections[0], def, mk(def, ['p1'], { today: '2026-11-06' }));
    assert('from a Friday, one workday lands on Monday', rowsOf(fri).find(r => r.sub_code === 'Surface Course').projected_finish === '2026-11-13'
      && rowsOf(fri).find(r => r.cost_code === 'Striping').projected_finish === '2026-11-10');
    const millDef = one('production_kpis', null, { dates: { preset: 'custom', from: '2026-10-01', to: '2026-10-10' } });
    const mill = rowsOf(PE.buildSectionData(millDef.sections[0], millDef, mk(millDef, ['p1'])))[0];
    assert('a completed line: remaining 0, est. days 0, no projected finish',
      mill && mill.qty_period === 5000 && mill.remaining_qty === 0 && mill.est_days_left === 0 && mill.projected_finish === null, J(mill));
    // A week stepped from a weekend must not land on the weekend.
    const sat = PE.buildSectionData(def.sections[0], def, mk(def, ['p1'], { today: '2026-11-07' }));
    const sun = PE.buildSectionData(def.sections[0], def, mk(def, ['p1'], { today: '2026-11-08' }));
    assert('from a Saturday or a Sunday, 5 workdays (one a holiday) is the Monday after next',
      rowsOf(sat).find(r => r.sub_code === 'Base Course').projected_finish === '2026-11-16'
        && rowsOf(sun).find(r => r.sub_code === 'Base Course').projected_finish === '2026-11-16',
      rowsOf(sat).find(r => r.sub_code === 'Base Course').projected_finish);

    // Decimal units: 0.1 MI on each of four days against a 1.6 MI bid leaves
    // 1.2 MI at 0.1 a day — 12 days. In floating point that division comes to
    // 12.000000000000002, and a bare ceil would say 13. Thu Nov 5 + 12
    // workdays (crossing two weekends and Veterans Day) = Tue Nov 24.
    const mi = { id: 'mi', 'project-name': 'Trail', bidItems: [{ cost_code: 'Trail', sub_code: 'Grade', unit: 'MI', quantity: '1.6', unit_cost: '1' }],
      dailyRows: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map(date =>
        ({ date, cost_code: 'Trail', sub_code: 'Grade', quantity: '0.1', labor_hours: '8' })) };
    const miDef = one('production_kpis', null, { dates: { preset: 'this_week' } });
    const miRow = rowsOf(PE.buildSectionData(miDef.sections[0], miDef,
      PE.makeContext(miDef, { getProjects: () => [mi] }, { pickedIds: ['mi'], today: TODAY })))[0];
    assert('decimal units: 1.2 MI left at 0.1 MI / day is 12 days, not 13 off a float tail → Tue Nov 24',
      miRow && miRow.est_days_left === 12 && miRow.projected_finish === '2026-11-24', J(miRow));
  }

  section('Bid progress, date-bounded');
  {
    const cols = PE.CATALOG.bid_progress.columns.map(c => c.key);
    const def = one('bid_progress', { columns: cols }, { dates: { preset: 'last_week' }, includeInternal: true });
    const sd = PE.buildSectionData(def.sections[0], def, mk(def, ['p1']));
    const rows = rowsOf(sd);
    const base = rows.find(r => r.sub_code === 'Base Course');
    // Last week Oct 26 – Nov 1: installed to its end = 700 (+ undated 0);
    // in it = 700. Rows after Nov 1 (Nov 2's 350) are not "to date" yet.
    assert('installed to date stops at the range end; installed this period is the range',
      base.installed_to_date === 700 && base.installed_period === 700 && base.remaining_qty === 1400);
    assert('% complete as of the range end', near(base.pct_complete, 700 / 2100 * 100));
    const mill = rows.find(r => r.cost_code === 'Milling');
    assert('a completed line reads Complete, 100%, nothing remaining, its last work day as target',
      mill.status === 'Complete' && mill.pct_complete === 100 && mill.remaining_qty === 0 && mill.target_date === '2026-10-06'
        && mill.start_date === '2026-10-05');
    const seed = rows.find(r => r.cost_code === 'Seeding');
    assert('typed dates stand; a line with no work is Not Started', seed.status === 'Not Started' && seed.start_date === '2026-11-10'
      && seed.target_date === '2026-11-20' && seed.installed_to_date === 0);
    const surf = rows.find(r => r.sub_code === 'Surface Course');
    assert('an open line\'s target is not invented from its last work day', surf.target_date === null && surf.status === 'Not Started');
    assert('variance = bid total − actual', near(base.variance, base.bid_total - base.actual_cost) && near(base.bid_total, 2100 * 85.57));
    const g = sd.blocks[0].groups;
    assert('grouped by cost code in bid order, subtotal on a group of two, none on a group of one',
      g.map(x => x.label).join() === 'Paving,Milling,Striping,Seeding' && g[0].subtotal && !g[1].subtotal);
    assert('a subtotal adds within one unit and labels itself', g[0].subtotal.cost_code === 'Subtotal' && g[0].subtotal.bid_qty === 2700
      && g[0].subtotal.unit === 'TON');
    const tot = sd.blocks[0].totals;
    // To Nov 1: Milling Oct 5–6, Base Oct 27, 28, 30 = 5 days; Zebediah,
    // Ann and Bob on them. Cal's striping (Nov 4) is after the range.
    assert('totals across units list each unit, sum the money, union the days and crew',
      tot.bid_qty === '2,700 TON · 5,800 SY · 2,000 LF'
        && near(tot.bid_total, rows.reduce((s, r) => s + r.bid_total, 0)) && tot.days_worked === 5 && tot.crew_size === 3,
      `${tot.bid_qty} / ${tot.days_worked} days / crew ${tot.crew_size}`);
    const hid = one('bid_progress', { options: { hideComplete: true, hideNotStarted: true, costCodes: ['Paving', 'Milling'] } });
    const hr = rowsOf(PE.buildSectionData(hid.sections[0], hid, mk(hid, ['p1'])));
    assert('hide complete / not started and the cost-code filter', hr.map(r => r.sub_code).join() === 'Base Course,Surface Course');
    const none = one('bid_progress', { options: { groupBy: 'none' } });
    const ng = PE.buildSectionData(none.sections[0], none, mk(none, ['p1'])).blocks[0].groups;
    assert('groupBy none: one unlabelled group, no subtotal', ng.length === 1 && ng[0].label === null && !ng[0].subtotal && ng[0].rows.length === 5);
  }

  section('Daily production — summarize, hide zero, group');
  {
    const def = one('daily_production', null, { dates: { preset: 'last_week' } });
    const sd = PE.buildSectionData(def.sections[0], def, mk(def, ['p1']));
    const rows = rowsOf(sd);
    assert('summarized: one row per day + sub code (two crew on Oct 27 → 300); the zero-quantity off-bid day hidden',
      JSON.stringify(rows.map(r => [r.date, r.sub_code, r.quantity, r.unit])) === JSON.stringify([
        ['2026-10-27', 'Base Course', 300, 'TON'], ['2026-10-28', 'Base Course', 250, 'TON'], ['2026-10-30', 'Base Course', 150, 'TON']]),
      JSON.stringify(rows));
    assert('totals: 700 TON', sd.blocks[0].totals.quantity === 700 && sd.blocks[0].totals.unit === 'TON' && sd.blocks[0].totals.date === 'Totals');
    const withEmp = one('daily_production', { columns: ['date', 'sub_code', 'quantity', 'employee', 'rate', 'labor_cost'] },
      { dates: { preset: 'last_week' }, includeInternal: true });
    const er = rowsOf(PE.buildSectionData(withEmp.sections[0], withEmp, mk(withEmp, ['p1'])));
    const oct27 = er.find(r => r.date === '2026-10-27');
    assert('with an internal column shown, the zero-quantity row stays', er.length === 4 && er.some(r => r.date === '2026-10-29'));
    assert('a summarized row: names that differ read Multiple, rates blend into cost per hour',
      oct27.employee === 'Multiple' && near(oct27.labor_cost, 471.3 + 400) && near(oct27.rate, (471.3 + 400) / 20));
    const flatDef = one('daily_production', { options: { summarize: false } }, { dates: { preset: 'last_week' } });
    assert('summarize off: a row per daily row', rowsOf(PE.buildSectionData(flatDef.sections[0], flatDef, mk(flatDef, ['p1']))).length === 4);
    const wk = one('daily_production', { options: { groupBy: 'week' } }, { dates: { preset: 'last_30' } });
    const wg = PE.buildSectionData(wk.sections[0], wk, mk(wk, ['p1'])).blocks[0].groups;
    assert('group by week: Monday-labelled weeks in order, each subtotalled per unit',
      wg.map(g => g.label).join('|') === 'Week of Oct 26, 2026|Week of Nov 2, 2026'
        && wg[0].subtotal.quantity === 700 && wg[1].subtotal.quantity === '470 TON · 800 LF', J(wg.map(g => g.subtotal)));
    const dy = one('daily_production', { options: { groupBy: 'date' } }, { dates: { preset: 'last_30' } });
    const dg = PE.buildSectionData(dy.sections[0], dy, mk(dy, ['p1'])).blocks[0].groups;
    assert('group by day', dg.map(g => g.label).join('|') === 'Oct 27, 2026|Oct 28, 2026|Oct 30, 2026|Nov 2, 2026|Nov 4, 2026'
      && dg[4].rows.length === 3 && dg[4].subtotal.quantity === '120 TON · 800 LF');
    const sc = one('daily_production', { options: { groupBy: 'sub_code' } }, { dates: { preset: 'last_30' } });
    const sg = PE.buildSectionData(sc.sections[0], sc, mk(sc, ['p1'])).blocks[0].groups;
    assert('group by sub code, by name', sg.map(g => g.label).join('|') === 'Base Course|Layout|Paint|Surface Course');
    const cc = one('daily_production', { options: { costCodes: ['Striping'] } }, { dates: { preset: 'last_30' } });
    assert('cost-code filter', rowsOf(PE.buildSectionData(cc.sections[0], cc, mk(cc, ['p1']))).every(r => r.cost_code === 'Striping'));
  }

  section('Materials, trucking, change orders, schedule');
  {
    const all = sec => PE.normalizeDefinition({ title: 'T', includeInternal: true, dates: { preset: 'last_30' },
      sections: [Object.assign(PE.newSection(sec), { columns: PE.CATALOG[sec].columns.map(c => c.key) })] });
    let def = all('materials');
    let rows = rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1'])));
    assert('materials: delivery lines in the range, the blank line skipped, another job\'s PO not shown',
      rows.map(r => r.invoice_num).join() === 'T-501,T-502' && rows[0].po_number === 'PO-1001' && rows[0].material === 'Hot Mix Base'
        && rows[0].supplier === 'Hot Mix Inc' && rows[0].po_status === 'Approved' && rows[0].qty === 22.5);
    assert('…tax off the line\'s percent, line total = amount + tax',
      near(rows[0].tax, 22.5 * 61.37 * 0.06) && near(rows[0].line_total, 22.5 * 61.37 * 1.06));
    def = all('materials'); def.dates = { preset: 'job_to_date', from: '', to: '' };
    rows = rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1'])));
    assert('job to date: by date, and an old dollar-tax line keeps its dollar tax',
      rows.map(r => r.invoice_num).join() === 'T-400,T-501,T-502' && near(rows[0].tax, 5));
    def = all('materials'); def.sections[0].options.summarize = true;
    const msd = PE.buildSectionData(def.sections[0], def, mk(def, ['p1']));
    rows = rowsOf(msd);
    assert('summarized: one row per material + supplier with a Deliveries count and the date span',
      rows.length === 1 && rows[0].qty === 42.5 && rows[0].deliveries === 2 && rows[0].date === 'Oct 27 – Oct 28, 2026'
        && rows[0].invoice_num === 'Multiple' && msd.columns.some(c => c.key === 'deliveries'));
    def = all('materials');
    const mtot = PE.buildSectionData(def.sections[0], PE.normalizeDefinition(Object.assign({}, def, { layout: 'combined' })), mk(def, ['p1', 'p2'])).blocks[0].totals;
    assert('a quantity total only when every line is one material', mtot.qty === null && near(mtot.tax, 22.5 * 61.37 * 0.06 + 20 * 61.37 * 0.06 + 10));

    def = all('trucking');
    rows = rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1'])));
    assert('trucking: tickets in the range, cost = rate × hours',
      rows.length === 1 && rows[0].tr_number === 'TR-0001' && rows[0].loads === 6 && near(rows[0].cost, 95.55 * 7.5) && rows[0].status === 'Approved');

    def = all('change_orders'); def.dates = { preset: 'job_to_date', from: '', to: '' };
    rows = rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1'])));
    assert('change orders: quantity and contract, by date', rows.map(r => `${r.kind}:${r.number}`).join() === 'Quantity:Q-1,Contract:CO-1'
      && rows[0].qty_change === 100 && rows[0].cost_code === 'Paving' && rows[1].amount === 12345.67 && rows[1].qty_change === null);
    def.dates = { preset: 'custom', from: '2026-10-16', to: '2026-10-31' };
    assert('a dated CO is held to the range', rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1']))).map(r => r.number).join() === 'CO-1');
    def.sections[0].options.kinds = ['quantity']; def.dates = { preset: 'job_to_date', from: '', to: '' };
    assert('kinds filter', rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1']))).map(r => r.number).join() === 'Q-1');
    assert('turf / kiewit jobs have no contract COs: none listed',
      rowsOf(PE.buildSectionData(all('change_orders').sections[0], all('change_orders'), mk(all('change_orders'), ['p2']))).length === 0);

    def = all('schedule');
    rows = rowsOf(PE.buildSectionData(def.sections[0], def, mk(def, ['p1'])));
    assert('schedule: bid items with a typed date; days left counts to the target',
      rows.length === 1 && rows[0].sub_code === 'Topsoil' && rows[0].days_left === 15 && rows[0].status === 'Not Started');
  }

  section('Several jobs: separate vs combined');
  {
    const def = PE.normalizeDefinition({ title: 'Two jobs', dates: { preset: 'last_30' }, sections: [
      PE.newSection('job_info'), PE.newSection('summary_kpis'), PE.newSection('bid_progress'),
      Object.assign(PE.newSection('notes'), { text: 'Said once.' }), PE.newSection('daily_production')] });
    const ctx = mk(def, ['p1', 'p2']);
    const sep = def.sections.map(s => PE.buildSectionData(s, def, ctx));
    assert('separate: a block per job, in picked order, no Job column',
      sep[2].blocks.length === 2 && sep[2].blocks[0].job.id === 'p1' && sep[2].blocks[1].job.id === 'p2'
        && !sep[2].columns.some(c => c.key === '_job'));
    const sepHtml = PE.buildReportHtml(def, ctx);
    const bands = [...new JSDOM(sepHtml).window.document.querySelectorAll('.job-band')].map(b => b.textContent);
    assert('…a job band per job, notes printed once',
      bands.length === 2 && /Route 30 Resurfacing/.test(bands[0]) && /Job #26101/.test(bands[0]) && /Acme Township/.test(bands[0])
        && sepHtml.split('Said once.').length === 2);
    const pbHtml = PE.buildReportHtml(Object.assign({}, def, { pageBreakPerJob: true }), ctx);
    const pbBands = [...new JSDOM(pbHtml).window.document.querySelectorAll('.job-band')];
    assert('page break per job: before every job but the first', !pbBands[0].classList.contains('pb') && pbBands[1].classList.contains('pb'));

    const comb = PE.normalizeDefinition(Object.assign({}, def, { layout: 'combined' }));
    const cctx = mk(comb, ['p1', 'p2']);
    const cs = comb.sections.map(s => PE.buildSectionData(s, comb, cctx));
    assert('combined: one block, tables lead with a Job column',
      cs[2].blocks.length === 1 && cs[2].blocks[0].job === null && cs[2].columns[0].key === '_job' && cs[2].columns[0].label === 'Job');
    const dpRows = rowsOf(cs[4]);
    assert('…each row names its job', dpRows.some(r => r._job === 'Route 30 Resurfacing · 26101') && dpRows.some(r => r._job === 'Elm Street Lot · 26102'));
    assert('…bid progress grouped by job and cost code', cs[2].blocks[0].groups.map(g => g.label).join('|').startsWith(
      'Route 30 Resurfacing · 26101 — Paving|Route 30 Resurfacing · 26101 — Milling'));
    const kpi = rowsOf(cs[1])[0];
    // Period days: p1 Oct 27, 28, 30, Nov 2, 3, 4 = 6; p2 Nov 2, 3 = 2.
    assert('…summary sums across jobs: days 6 + 2, items, quantity per unit',
      kpi.days_worked === 8 && kpi.items_complete === '1 of 7' && kpi.qty_period === '1,350 TON · 800 LF · 1,500 SY', J(kpi));
    const s1 = rowsOf(sep[1], 0)[0], s2 = rowsOf(sep[1], 1)[0];
    const b1 = 2100 * 85.57 + 600 * 92.25 + 5000 * 2.4 + 2000 * 0.9 + 800 * 3, b2 = 300 * 95 + 4000 * 0.5;
    assert('…% complete weighed by each job\'s bid dollars', near(kpi.pct_complete, (b1 * s1.pct_complete + b2 * s2.pct_complete) / (b1 + b2)));
    assert('…a card per job', cs[0].blocks[0].groups[0].rows.length === 2);
    const cHtml = PE.buildReportHtml(comb, cctx);
    save('combined.html', cHtml);
    assert('…no job bands; the cards carry the job names', !/class="job-band/.test(cHtml) && (cHtml.match(/class="ji-h"/g) || []).length === 2);
  }

  // ────────────────────────────────────────────────────────────────────────
  section('Customer-safe: internal columns never reach the output');
  {
    const S = SECRET;
    const RAW = [S.employee, S.rate, S.equipment, S.jobClass, S.materialCost, '1,234.57', S.supplier, S.note,
      S.contract, '251,234.56', S.coAmount, '12,345.67', S.invoiced, '80,321.09', S.driver, S.truckRate, '716.63', '716.625',
      S.poUnitCost, S.bidUnitCost, S.baseUnitCost, '0.0725', 'Ann Lee', 'Bob Ray'];
    const catalogLabels = new Set(), safeLabels = new Set();
    Object.values(PE.CATALOG).forEach(c => c.columns.forEach(col => (col.internal ? catalogLabels : safeLabels).add(col.label)));
    const internalOnly = [...catalogLabels].filter(l => !safeLabels.has(l));
    const thTexts = html => [...new JSDOM(html).window.document.querySelectorAll('th, .sum-label, .ji-k')].map(e => e.textContent.trim());
    const xlsxStrings = wb => Object.values(wb.sheets).flatMap(cells => Object.values(cells).filter(c => c.t === 'inlineStr').map(c => c.v));

    for (const layout of ['separate', 'combined']) {
      for (const preset of ['job_to_date', 'last_30']) {
        const def = allColumnsDef(PE, { layout, dates: { preset, from: '', to: '' } });
        const ctx = mk(def, ['p1', 'p2']);
        const eff = def.sections.flatMap(s => PE.effectiveColumns(s, def, ctx.perm));
        const html = PE.buildReportHtml(def, ctx);
        const wb = workbook(PE.buildXlsx(def, ctx));
        const xmlAll = Object.values(wb.parts).join('\n');
        const heads = thTexts(html), xs = xlsxStrings(wb);
        assert(`${layout}/${preset}: effectiveColumns returns no internal column`, eff.length > 20 && !eff.some(c => c.internal));
        assert(`${layout}/${preset}: no internal header in the HTML`, !heads.some(h => internalOnly.includes(h)), heads.filter(h => internalOnly.includes(h)).join());
        assert(`${layout}/${preset}: no internal value in the HTML`, !RAW.some(v => html.includes(v)), RAW.filter(v => html.includes(v)).join());
        assert(`${layout}/${preset}: no internal header in the XLSX`, !xs.some(x => internalOnly.includes(x)), xs.filter(x => internalOnly.includes(x)).join());
        assert(`${layout}/${preset}: no internal value anywhere in the XLSX`, !RAW.some(v => xmlAll.includes(v)), RAW.filter(v => xmlAll.includes(v)).join());
        assert(`${layout}/${preset}: no INTERNAL tag`, !/INTERNAL/.test(html) && !xs.some(x => /INTERNAL/.test(x)));
        if (layout === 'separate' && preset === 'job_to_date') { save('customer-safe.html', html); save('customer-safe.xlsx', PE.buildXlsx(def, ctx)); }
      }
    }
    const defAll = allColumnsDef(PE);
    assert('columnState: internal is locked while customer-safe', PE.columnState('bid_progress', 'actual_cost', defAll, {}) === 'locked'
      && PE.columnState('bid_progress', 'bid_qty', defAll, {}) === 'available' && PE.columnState('bid_progress', 'nope', defAll, {}) === 'hidden');
    assert('includeInternal must be literally true', PE.columnState('bid_progress', 'actual_cost', { includeInternal: 'true' }, {}) === 'locked');
    assert('hasInternal false while customer-safe, even with every column chosen', PE.hasInternal(defAll, {}) === false);
    // A section of nothing but locked columns prints nothing — not an empty frame.
    const lockedOnly = PE.normalizeDefinition({ title: 'T', sections: [Object.assign(PE.newSection('trucking'), { columns: ['driver', 'cost'] })] });
    const lh = PE.buildReportHtml(lockedOnly, mk(lockedOnly, ['p1']));
    assert('a section with only locked columns is left out entirely', !/Trucking/.test(lh) && !/<table/.test(lh));

    // Internal data on, but the role cannot open Financials.
    const intDef = allColumnsDef(PE, { includeInternal: true });
    const lvl2 = { role: 'level2', canSeeCosts: true, canSeeFinancials: false };
    const ctx2 = mk(intDef, ['p1', 'p2'], null, { perm: lvl2 });
    const html2 = PE.buildReportHtml(intDef, ctx2);
    const wb2 = workbook(PE.buildXlsx(intDef, ctx2));
    const xml2 = Object.values(wb2.parts).join('\n');
    const finLabels = ['Contract Value', 'Retention', 'Invoiced', 'Contract Change Orders', 'GP Earned to Date', 'Amount'];
    const FIN_RAW = [S.contract, '251,234.56', '263,580.23', '263580.23', S.invoiced, '80,321.09', '0.0725', '7.3%', S.coAmount, '12,345.67'];
    assert('financial columns are hidden from a role without Financials, even with internal data on',
      PE.columnState('summary_kpis', 'gp_earned', intDef, lvl2) === 'hidden' && PE.hiddenFinancialCount(intDef, lvl2) === 7
        && PE.hiddenFinancialCount(intDef, { canSeeFinancials: true }) === 0);
    assert('…no contract / profit header in HTML or XLSX', !thTexts(html2).some(h => finLabels.includes(h))
      && !xlsxStrings(wb2).some(x => finLabels.includes(x)));
    assert('…no contract / profit value in HTML or XLSX', !FIN_RAW.some(v => html2.includes(v) || xml2.includes(v)),
      FIN_RAW.filter(v => html2.includes(v) || xml2.includes(v)).join());
    assert('…while the other internal columns do show, under the INTERNAL tag',
      thTexts(html2).includes('Actual Cost') && html2.includes(S.employee) && /INTERNAL — contains cost data\. Not for customer distribution\./.test(html2)
        && xlsxStrings(wb2).some(x => /^INTERNAL/.test(x)));
    const full = PE.buildReportHtml(intDef, mk(intDef, ['p1', 'p2']));
    save('internal.html', full);
    assert('with Financials, the contract does print', full.includes('$263,580.23') && thTexts(full).includes('GP Earned to Date'));
    const noCost = mk(intDef, ['p1'], null, { perm: { canSeeCosts: false } });
    assert('a role that cannot see costs gets no internal column at all',
      intDef.sections.every(s => PE.effectiveColumns(s, intDef, noCost.perm).every(c => !c.internal)));

    // The INTERNAL tag follows the columns, not the switch.
    const safeOn = PE.normalizeDefinition({ title: 'T', includeInternal: true, sections: [PE.newSection('bid_progress')] });
    const sh = PE.buildReportHtml(safeOn, mk(safeOn, ['p1']));
    assert('internal data switched on but no internal column chosen: no INTERNAL tag', PE.hasInternal(safeOn, {}) === false && !/INTERNAL/.test(sh));
  }

  section('Escaping');
  {
    const def = PE.normalizeDefinition({
      title: '</title><script>alert("t")</script>',
      header: { preparedFor: '<i>you</i>', preparedBy: 'A & B', intro: '<b>hi</b>\nthere', footer: '<u>f</u>' },
      sections: [
        PE.newSection('job_info'), PE.newSection('summary_kpis'),
        Object.assign(PE.newSection('bid_progress'), { title: '<h1>x</h1>', labels: { cost_code: '<img src=y>' } }),
        PE.newSection('daily_production'),
        Object.assign(PE.newSection('notes'), { title: 'N<o>tes', text: '<script>alert(3)</script>\nline two\n\npara two' }),
      ] });
    for (const layout of ['separate', 'combined']) {
      const dd = PE.normalizeDefinition(Object.assign({}, def, { layout }));
      const html = PE.buildReportHtml(dd, mk(dd, ['p3', 'p1']));
      const doc = new JSDOM(html).window.document;
      assert(`${layout}: a job named <img onerror> prints as text`, html.includes('&lt;img src&#61;x onerror&#61;alert(1)&gt;') && !html.includes('<img src=x'));
      assert(`${layout}: no element reaches the page from user text`,
        doc.querySelectorAll('img, script, iframe, b, i, u').length === 0 && doc.querySelectorAll('h1').length === 1,
        [...doc.querySelectorAll('img, script, b, i, u')].map(e => e.outerHTML).join(' '));
      assert(`${layout}: title, labels, cost codes, notes and header fields all escaped`,
        doc.title === '</title><script>alert("t")</script>' && html.includes('&lt;b&gt;CC&lt;/b&gt;') && html.includes('O&#39;Brien &amp; Sons')
          && html.includes('&lt;img src&#61;y&gt;') && html.includes('&lt;i&gt;you&lt;/i&gt;') && html.includes('&lt;u&gt;f&lt;/u&gt;'));
    }
    const html = PE.buildReportHtml(def, mk(def, ['p1']));
    assert('notes: blank lines → paragraphs, single newlines → <br>',
      html.includes('<p>&lt;script&gt;alert(3)&lt;/script&gt;<br>line two</p><p>para two</p>'));
    const wb = workbook(PE.buildXlsx(def, mk(def, ['p3'])));
    assert('XLSX: hostile text round-trips as text, every part still parses', !wb.bad.length
      && Object.values(wb.sheets).some(c => Object.values(c).some(x => x.v === '<img src=x onerror=alert(1)> · "><b>9</b>')));
  }

  section('The report document');
  {
    const def = PE.normalizeDefinition({ title: 'Weekly Progress Update', orientation: 'landscape', dates: { preset: 'last_month' },
      header: { preparedFor: 'Acme Township', preparedBy: 'Sam Super', intro: 'Here is where things stand.', footer: 'Questions? Call the office.' },
      sections: [PE.newSection('summary_kpis'), PE.newSection('bid_progress'), PE.newSection('schedule'), PE.newSection('change_orders'),
        PE.newSection('trucking')] });
    const ctx = mk(def, ['p1']);
    const html = PE.buildReportHtml(def, ctx);
    save('weekly-progress.html', html);
    const doc = new JSDOM(html).window.document;
    const mast = doc.querySelectorAll('[data-dw-brand]');
    assert('a full HTML document', /^<!DOCTYPE html>/i.test(html) && /<\/html>$/.test(html));
    assert('one masthead, carrying data-dw-brand', mast.length === 1 && mast[0].classList.contains('masthead'));
    assert('…the DataWatch wordmark, division sub-label, report title and generated time',
      doc.querySelector('.mast-word').textContent === 'DataWatch' && doc.querySelector('.mast-sub').textContent === 'Paving Division'
        && doc.querySelector('.mast-rpt').textContent === 'Weekly Progress Update' && doc.querySelector('.mast-date').textContent === 'Generated Nov 5, 2026, 2:30 PM');
    assert('…styled as the Job Summary masthead', /\.mast-word\{font-size:24px;font-weight:800;letter-spacing:\.14em;text-transform:uppercase;color:#22c55e/.test(html)
      && /border-bottom:3px solid #22c55e/.test(html));
    const brand = { console };
    vm.createContext(brand);
    brand.window = brand;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'report-branding.js'), 'utf8'), brand);
    assert('dwBrand leaves it with the single masthead (no second band)', brand.dwBrand(html) === html);
    assert('title, meta line (job, range, prepared for / by) and intro',
      doc.querySelector('h1').textContent === 'Weekly Progress Update'
        && doc.querySelector('p.meta').textContent === 'Route 30 Resurfacing · Job #26101 · Oct 1 – Oct 31, 2026 · Prepared for Acme Township · Prepared by Sam Super'
        && doc.querySelector('p.intro').textContent === 'Here is where things stand.');
    assert('summary strip uses the sum-bar classes report-email.js lifts',
      doc.querySelectorAll('.sum-bar .sum-metric .sum-label + .sum-val').length === 4);
    assert('self-contained: no external resource, no script', !/<script|<link|src=|@import|url\(/i.test(html));
    assert('print rules: page size and orientation, thead repeats, rows hold together, colour kept',
      html.includes('@page{size:letter landscape;margin:0.45in}') && html.includes('thead{display:table-header-group}')
        && /tr\{page-break-inside:avoid/.test(html) && html.includes('-webkit-print-color-adjust:exact'));
    assert('numbers right-aligned', [...doc.querySelectorAll('th')].some(th => th.textContent === 'Bid Qty' && th.className === 'num'));
    assert('a quantity change order reads signed, with its unit (Q-1 is dated Oct 15)', /<td class="num">\+100 TON<\/td>/.test(html));
    // This week (Nov 2–8) holds no change order and no trucking ticket.
    const thisWeek = PE.buildReportHtml(Object.assign({}, def, { dates: { preset: 'this_week' } }), ctx);
    assert('an empty section says so', /No change orders in this period\./.test(thisWeek) && /No trucking tickets in this period\./.test(thisWeek)
      && !/\+100 TON/.test(thisWeek));
    assert('footer: the note, then "DataWatch — <title>"', doc.querySelector('.rpt-foot').textContent === 'Questions? Call the office.DataWatch — Weekly Progress Update');
    const bars = doc.querySelectorAll('.tl-bar');
    assert('schedule bars: one per row, with the job end-date marker', bars.length === 1 && doc.querySelectorAll('.tl-end').length === 1
      && /left:0\.00%/.test(bars[0].getAttribute('style')));
    const noGen = PE.buildReportHtml(Object.assign({}, def, { header: Object.assign({}, def.header, { showGenerated: false }) }), ctx);
    assert('show generated off: no stamp', !/Generated/.test(noGen));
    const bare0 = PE.buildReportHtml(PE.normalizeDefinition({ sections: [PE.newSection('bid_progress')] }), mk({}, []));
    assert('no jobs: still a valid document that says so; title falls back', /No jobs selected/.test(bare0) && /<h1 class="rpt-title">Custom Report<\/h1>/.test(bare0));
    const named = PE.makeContext(PE.defaultDefinition(), cfgFor(env, d0), { reportName: 'My Saved Report', today: TODAY });
    assert('a blank title prints the report name', named.title === 'My Saved Report'
      && /<h1 class="rpt-title">My Saved Report<\/h1>/.test(PE.buildReportHtml(PE.defaultDefinition(), named)));
    assert('makeContext reports jobs that no longer exist', J(mk({}, ['p1', 'gone'])).missing.join() === 'gone');
    // A context made before the dates changed still prints the new range.
    const stale = mk(def, ['p1']);
    const moved = PE.buildReportHtml(Object.assign({}, def, { dates: { preset: 'last_7' } }), stale);
    assert('a newer definition\'s dates win over an older context\'s', /Oct 30 – Nov 5, 2026/.test(moved));
    assert('size stays modest: class-based CSS, no per-cell styles', !/<td[^>]*style=/.test(html));
  }

  section('XLSX');
  {
    const def = allColumnsDef(PE, { includeInternal: true, title: 'Weekly: Progress/Update <A>', dates: { preset: 'last_30' } });
    def.sections.push(Object.assign(PE.newSection('trucking'), { title: 'Bid Item Progress' }));                 // clashes
    def.sections.push(Object.assign(PE.newSection('materials'), { title: 'A really long section title with [bad]:*?/\\ chars' }));
    const nd = PE.normalizeDefinition(def);
    const ctx = mk(nd, ['p1', 'p2']);
    const u8 = PE.buildXlsx(nd, ctx);
    save('everything.xlsx', u8);
    const wb = workbook(u8);
    assert('a valid stored ZIP; every part parses as XML', !wb.bad.length, wb.bad.join());
    assert('the parts Excel needs', ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']
      .every(n => wb.parts[n]));
    const tableCount = nd.sections.filter(s => PE.CATALOG[s.type].table).length;
    const chartCount = nd.sections.filter(s => s.type === 'chart').length;
    assert('a Report sheet first, then one per table section, then a Chart data sheet per chart',
      wb.names[0] === 'Report' && wb.names.length === 1 + tableCount + chartCount && wb.names[wb.names.length - 1] === 'Chart data', wb.names.join(' | '));
    assert('sheet names: ≤ 31 chars, no []:*?/\\, unique', wb.names.every(n => n.length <= 31 && !/[\[\]:*?\/\\]/.test(n))
      && new Set(wb.names.map(n => n.toLowerCase())).size === wb.names.length && wb.names.includes('Bid Item Progress (2)'), wb.names.join(' | '));
    assert('content types and relationships list every sheet', wb.names.every((_, i) =>
      wb.parts['[Content_Types].xml'].includes(`/xl/worksheets/sheet${i + 1}.xml`) && wb.parts['xl/_rels/workbook.xml.rels'].includes(`worksheets/sheet${i + 1}.xml`)));
    assert('only the first sheet is selected', (Object.keys(wb.parts).filter(n => /worksheets\/sheet/.test(n))
      .filter(n => wb.parts[n].includes('tabSelected="1"'))).join() === 'xl/worksheets/sheet1.xml');
    const rep = wb.sheets.Report, vals = Object.values(rep).map(c => c.v);
    assert('Report sheet: title, jobs, date range, generated, and the INTERNAL warning',
      vals.includes('Weekly: Progress/Update <A>') && vals.includes('Route 30 Resurfacing · 26101; Elm Street Lot · 26102')
        && vals.includes('Oct 7 – Nov 5, 2026') && vals.includes('Nov 5, 2026, 2:30 PM') && vals.some(v => /^INTERNAL/.test(v)));
    assert('…with each job card and summary strip as label / value rows', vals.includes('Job Information — Route 30 Resurfacing · 26101')
      && vals.includes('Summary Figures — Elm Street Lot · 26102') && vals.includes('Superintendent'));

    const bpc = wb.sheets['Bid Item Progress'];
    const h = name => findCell(bpc, name);
    const bq = h('Bid Qty'), pc = h('% Complete'), jb = h('Job'), sub = h('Sub Code');
    const baseRow = +Object.keys(bpc).find(r => r.startsWith(sub.col) && bpc[r].v === 'Base Course').replace(/\D+/g, '');
    const cell = (c, r) => bpc[c + r];
    assert('several jobs in a sheet carry a Job column', jb && cell(jb.col, baseRow).v === 'Route 30 Resurfacing · 26101');
    assert('quantities are numbers', cell(bq.col, baseRow).t === null && cell(bq.col, baseRow).v === 2100 && wb.styles[cell(bq.col, baseRow).s] === '#,##0.00');
    assert('percentages are fractions under a % format', near(cell(pc.col, baseRow).v, 0.5) && wb.styles[cell(pc.col, baseRow).s] === '0.0%');
    const money = h('Bid Total');
    assert('money is a number under a $ format', near(cell(money.col, baseRow).v, 2100 * 85.57) && /"\$"#,##0\.00/.test(wb.styles[cell(money.col, baseRow).s]));
    const pk = wb.sheets['Production Rates'];
    const fin = findCell(pk, 'Projected Finish'), psub = findCell(pk, 'Sub Code');
    const pRow = +Object.keys(pk).find(r => r.startsWith(psub.col) && pk[r].v === 'Base Course').replace(/\D+/g, '');
    assert('dates are real date serials under a date format', pk[fin.col + pRow].v === serial('2026-11-13')
      && wb.styles[pk[fin.col + pRow].s] === 'mmm d, yyyy');
    const co = wb.sheets['Change Orders'];
    const qc = findCell(co, 'Qty Change');
    const qcCell = Object.keys(co).filter(r => r.startsWith(qc.col) && r !== qc.col + qc.row).map(r => co[r]).find(c => typeof c.v === 'number');
    // Last 30 days (Oct 7 on) holds Q-1, dated Oct 15: +100 TON.
    assert('a quantity change order is a number, its unit in the format', qcCell && qcCell.v === 100 && /" TON"/.test(wb.styles[qcCell.s]));
    const head = findCell(bpc, 'Cost Code');
    assert('the header row is frozen and repeats on every printed page',
      wb.parts['xl/worksheets/sheet2.xml'].includes(`ySplit="${head.row}"`) && wb.parts['xl/workbook.xml'].includes(`'Bid Item Progress'!$${head.row}:$${head.row}`));
    const totRef = Object.keys(bpc).find(r => bpc[r].v === 'Totals — Route 30 Resurfacing · 26101');
    const totRow = totRef && +totRef.replace(/\D+/g, '');
    const mat = wb.sheets['Materials Delivered'], mq = findCell(mat, 'Qty');
    const matTot = Object.keys(mat).find(r => mat[r].v === 'Totals — Route 30 Resurfacing · 26101');
    assert('a mixed-unit total is text; a single-material total a number',
      totRow && bpc[bq.col + totRow].t === 'inlineStr' && bpc[bq.col + totRow].v === '2,700 TON · 5,800 SY · 2,000 LF'
        && matTot && mat[mq.col + matTot.replace(/\D+/g, '')].v === 42.5,
      totRow && JSON.stringify(bpc[bq.col + totRow]));
    assert('file name: <title>-<date>.xlsx, sanitised (tagged INTERNAL here)', PE.xlsxFileName(nd, ctx) === 'Weekly-Progress-Update-A-INTERNAL-2026-11-05.xlsx'
      && PE.xlsxFileName(PE.defaultDefinition(), { today: TODAY }) === 'Custom-Report-2026-11-05.xlsx');
    // Same bytes with or without TextEncoder: the bare-vm encoder is exact.
    const withTE = bareEngine({ TextEncoder }).FCTReportEngine;
    const noTE = bareEngine().FCTReportEngine;
    const mkB = (Eng, dd) => Eng.makeContext(dd, cfgFor({}, d0), { pickedIds: ['p1', 'p3'], today: TODAY, now: NOW });
    const uni = PE.normalizeDefinition({ title: 'Ünïcødé — “quotes” 🚧 \uD800 lone', sections: [PE.newSection('bid_progress')] });
    const a = toBuf(withTE.buildXlsx(uni, mkB(withTE, uni))), b = toBuf(noTE.buildXlsx(uni, mkB(noTE, uni)));
    assert('the built-in UTF-8 encoder matches TextEncoder byte for byte (emoji, lone surrogate)', a.equals(b) && !workbook(b).bad.length);
    const empty = workbook(PE.buildXlsx(PE.defaultDefinition(), mk({}, [])));
    assert('a report with no table sections is still a valid one-sheet workbook', !empty.bad.length && empty.names.join() === 'Report');
  }

  section('Figures where bid lines overlap, ranges are in the past, and holidays fall');
  {
    const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
    const envs = PAGES.map(f => pageEngine(f));
    const noHelp = { file: 'no helpers', ctx: bareEngine(), helpers: undefined };
    const engines = envs.concat([noHelp]);
    const makeIn = (env, def, data, opts) => env.ctx.FCTReportEngine.makeContext(def,
      cfgFor(env, data), Object.assign({ today: TODAY, now: NOW }, opts || {}));
    const withData = (env, data, fn) => {
      const prev = env.ctx.projectsList;
      env.ctx.projectsList = data.projects;
      try { return fn(); } finally { env.ctx.projectsList = prev; }
    };

    // ── Overlapping lines (the "+ Sub Code" shape): each row counted once ──
    const overlap = (blankUnit, rows) => ({
      projects: [{ id: 'ov', 'project-name': 'Overlap Job', status: 'In Progress',
        bidItems: [
          blankUnit ? { id: 'o1', cost_code: 'Striping', sub_code: '', unit: '', quantity: '', unit_cost: '' }
            : { id: 'o1', cost_code: 'Striping', sub_code: '', unit: 'LF', quantity: '2000', unit_cost: '1' },
          { id: 'o2', cost_code: 'Striping', sub_code: 'Thermo', unit: 'LF', quantity: '500', unit_cost: '2' },
        ],
        dailyRows: rows }],
      pos: [], trucks: [],
    });
    const ovRows = [
      { id: 'q1', date: '2026-11-02', cost_code: 'Striping', sub_code: 'Thermo', quantity: '300', labor_hours: '8', rate: '30', employee: 'A' },
      { id: 'q2', date: '2026-11-03', cost_code: 'Striping', sub_code: 'Paint', quantity: '200', labor_hours: '4', rate: '30', employee: 'B' },
    ];
    for (const env of engines) {
      const PE2 = env.ctx.FCTReportEngine;
      const data = overlap(false, ovRows);
      const def = PE2.normalizeDefinition({ title: 'Overlap', dates: { preset: 'this_week' }, includeInternal: true,
        sections: [PE2.newSection('summary_kpis'), Object.assign(PE2.newSection('bid_progress'), {
          columns: ['cost_code', 'sub_code', 'unit', 'bid_qty', 'installed_to_date', 'installed_period', 'remaining_qty', 'actual_cost', 'labor_hours'] }),
        PE2.newSection('daily_production')] });
      withData(env, data, () => {
        const ctx = makeIn(env, def, data, { pickedIds: ['ov'] });
        const sum = rowsOf(PE2.buildSectionData(def.sections[0], def, ctx))[0];
        const bp = PE2.buildSectionData(def.sections[1], def, ctx).blocks[0].totals;
        const dp = PE2.buildSectionData(def.sections[2], def, ctx).blocks[0].totals;
        assert(`${env.file}: summary Qty Installed = Daily Production total = 500, not 800`,
          sum.qty_period === 500 && dp.quantity === 500, `${sum.qty_period} / ${dp.quantity}`);
        assert(`${env.file}: bid-progress totals count each shared row once (installed 500, this period 500, remaining not invented)`,
          bp.installed_to_date === 500 && bp.installed_period === 500 && bp.remaining_qty === null, JSON.stringify(J(bp)));
        assert(`${env.file}: …and the cost and hours behind them once ($360, 12 h)`,
          near(bp.actual_cost, 360) && near(bp.labor_hours, 12), JSON.stringify(J(bp)));
        if (env.helpers) {
          const b = data.projects[0].bidItems;
          assert(`${env.file}: each line's own figure is still the page's (500 and 300)`,
            near(env.ctx.runningQtyForBidItem(b[0], 'ov'), 500) && near(env.ctx.runningQtyForBidItem(b[1], 'ov'), 300)
              && rowsOf(PE2.buildSectionData(def.sections[1], def, ctx)).map(r => r.installed_to_date).join() === '500,300');
        }
        const html = PE2.buildReportHtml(def, ctx);
        assert(`${env.file}: the printed strip says 500 LF`, /500 LF/.test(html) && !/800 LF/.test(html));
      });
      // A blank-unit wildcard line, as "+ Sub Code" leaves it.
      const blank = overlap(true, [ovRows[0], Object.assign({}, ovRows[1], { sub_code: 'Thermo' })]);
      withData(env, blank, () => {
        const ctx = makeIn(env, def, blank, { pickedIds: ['ov'] });
        const sd = PE2.buildSectionData(def.sections[0], def, ctx);
        const row = sd.blocks[0].groups[0].rows[0];
        assert(`${env.file}: a blank-unit line beside it adds no unlabelled extra figure (500 LF, nothing else)`,
          row.cells.qty_period === 500 && row.unit === 'LF', JSON.stringify(J(row)));
      });
    }

    // ── Projected cost on a past range is today's figure (paving helpers) ──
    const pav = envs[1];
    const PP = pav.ctx.FCTReportEngine;
    const realNow = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const projData = {
      projects: [{ id: 'pj', 'project-name': 'Proj Job', status: 'In Progress',
        bidItems: [{ id: 'g1', cost_code: 'CC2', sub_code: 'S2', unit: 'TON', quantity: '300', unit_cost: '60',
          start_date: '2026-10-01', target_date: '2026-12-31' }],
        dailyRows: [
          { id: 'z1', date: '2026-10-10', cost_code: 'CC2', sub_code: 'S2', quantity: '40', labor_hours: '50', rate: '30' },
          { id: 'z2', date: '2026-11-03', cost_code: 'CC2', sub_code: 'S2', quantity: '10', labor_hours: '10', rate: '50' },
        ] }],
      pos: [], trucks: [],
    };
    const snap = PP.STARTERS.find(s => s.id === 'internal_cost_snapshot').definition;
    for (const preset of ['job_to_date', 'last_month']) {
      const def = PP.normalizeDefinition(Object.assign(J(snap), { dates: { preset, from: '', to: '' } }));
      withData(pav, projData, () => {
        const ctx = makeIn(pav, def, projData, { pickedIds: ['pj'], now: realNow });
        const row = rowsOf(PP.buildSectionData(def.sections[1], def, ctx))[0];
        const tot = PP.buildSectionData(def.sections[1], def, ctx).blocks[0].totals;
        const sum = rowsOf(PP.buildSectionData(def.sections[0], def, ctx))[0];
        const b = projData.projects[0].bidItems[0];
        const want = pav.ctx.projForBidItem(b, pav.ctx.actualForBidItem(b, 'pj'), pav.ctx.runningQtyForBidItem(b, 'pj'), 300, 18000, false);
        const rel = (a, x) => Math.abs(a - x) <= 1e-4 * Math.max(1, Math.abs(x));
        assert(`${preset}: a line's Projected Cost is the page's projection today (${want.toFixed(2)})`,
          rel(row.projected_cost, want), `${row.projected_cost} vs ${want}`);
        assert(`${preset}: bid-progress Totals projected cost = the summary strip's (no off-bid spend here)`,
          rel(tot.projected_cost, sum.projected_cost), `${tot.projected_cost} vs ${sum.projected_cost}`);
      });
    }

    // ── The fallback projection measures time as the page does ──
    const NE2 = bareEngine().FCTReportEngine;
    for (const back of [10, 1, 0]) {
      const start = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() - back);
      const end = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate() + 20);
      const dd = {
        projects: [{ id: 'fp', 'project-name': 'Fallback Job', status: 'In Progress',
          bidItems: [{ id: 'f1', cost_code: 'Mill', sub_code: 'M', unit: 'SY', quantity: '1000', unit_cost: '30',
            start_date: iso(start), target_date: iso(end) }],
          dailyRows: [{ id: 'fr', date: iso(start), cost_code: 'Mill', sub_code: 'M', quantity: '100', total_cost: '6000' }] }],
        pos: [], trucks: [],
      };
      const def = PP.normalizeDefinition({ title: 'F', includeInternal: true, sections: [
        Object.assign(PP.newSection('bid_progress'), { columns: ['sub_code', 'projected_cost'] }),
        Object.assign(PP.newSection('summary_kpis'), { columns: ['projected_cost'] })] });
      withData(pav, dd, () => {
        const today = iso(realNow);
        const c1 = PP.makeContext(def, cfgFor(pav, dd), { pickedIds: ['fp'], today, now: new Date() });
        const c2 = NE2.makeContext(def, cfgFor({}, dd), { pickedIds: ['fp'], today, now: new Date() });
        const a = rowsOf(PP.buildSectionData(def.sections[0], def, c1))[0].projected_cost;
        const b = rowsOf(NE2.buildSectionData(def.sections[0], def, c2))[0].projected_cost;
        const sa = rowsOf(PP.buildSectionData(def.sections[1], def, c1))[0].projected_cost;
        const sb = rowsOf(NE2.buildSectionData(def.sections[1], def, c2))[0].projected_cost;
        const rel = (x, y) => Math.abs(x - y) <= 1e-3 * Math.max(1, Math.abs(y));
        assert(`a dated line started ${back} day(s) ago: the fallback projection equals the page helper's (line and job)`,
          rel(a, b) && rel(sa, sb), `${a} vs ${b}; ${sa} vs ${sb}`);
      });
    }

    // ── Projected finish skips the pages' holidays; past ten years it is "—" ──
    const prodData = (left, perDay, today) => {
      const yday = (() => { const t = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - 86400000;
        return new Date(t).toISOString().slice(0, 10); })();
      return { projects: [{ id: 'pr', 'project-name': 'Prod', status: 'In Progress',
        bidItems: [{ id: 'k1', cost_code: 'Seal', sub_code: 'Coat', unit: 'SY', quantity: String(left + perDay), unit_cost: '1' }],
        dailyRows: [{ id: 'kr', date: yday, cost_code: 'Seal', sub_code: 'Coat', quantity: String(perDay), labor_hours: '8' }] }],
        pos: [], trucks: [] };
    };
    const cases = [
      ['2026-11-05', 500, 100, '2026-11-13', 'Veterans Day'], ['2026-11-05', 2000, 100, '2026-12-07', 'Veterans Day and Thanksgiving'],
      ['2026-11-20', 500, 100, '2026-11-30', 'Thanksgiving'], ['2026-12-21', 500, 100, '2026-12-29', 'Christmas'],
      ['2026-11-05', 100000, 1, null, 'past the ten-year cap'],
    ];
    for (const env of [pav, noHelp]) {
      const E2 = env.ctx.FCTReportEngine;
      const def = E2.normalizeDefinition({ title: 'P', dates: { preset: 'last_7' },
        sections: [Object.assign(E2.newSection('production_kpis'), { options: { totals: true } })] });
      for (const [today, left, perDay, want, why] of cases) {
        const dd = prodData(left, perDay, today);
        withData(env, dd, () => {
          const ctx = E2.makeContext(def, cfgFor(env, dd), { pickedIds: ['pr'], today, now: NOW });
          const sd = E2.buildSectionData(def.sections[0], def, ctx);
          const row = rowsOf(sd)[0];
          if (want) {
            assert(`${env.file}: ${left} left at ${perDay}/day from ${today} finishes ${want} (${why})`,
              row && row.projected_finish === want && sd.blocks[0].totals.projected_finish === want, row && row.projected_finish);
          } else {
            const html = E2.buildReportHtml(def, ctx);
            assert(`${env.file}: ${left} left at ${perDay}/day has no finish and no days-left (${why}), printed "—", never NaN`,
              row && row.projected_finish === null && row.est_days_left === null && sd.blocks[0].totals.projected_finish === null
                && !/NaN|2[1-9]\d\d-/.test(html), row && JSON.stringify(row));
          }
        });
      }
    }
    if (pav.helpers.addWorkingDays) {
      assert('the engine\'s fallback calendar is the page\'s, day for day, through 2027',
        (() => {
          const NE3 = bareEngine().FCTReportEngine;
          const def = NE3.normalizeDefinition({ title: 'P', dates: { preset: 'last_7' }, sections: [NE3.newSection('production_kpis')] });
          for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 86400000 * 3) {
            const today = new Date(t).toISOString().slice(0, 10);
            const dd = prodData(700, 100, today);
            const got = rowsOf(NE3.buildSectionData(def.sections[0], def, NE3.makeContext(def, cfgFor({}, dd), { pickedIds: ['pr'], today })))[0];
            if (!got || got.projected_finish !== pav.helpers.addWorkingDays(today, 7)) return false;
          }
          return true;
        })());
    }

    // ── Bid-progress Totals % rolls up by cost code, as bidProjectPct does ──
    const pctData = {
      projects: [{ id: 'pc', 'project-name': 'Pct Job', status: 'In Progress',
        bidItems: [
          { id: 'c1', cost_code: 'CC1', sub_code: 'S1', unit: 'EA', quantity: '10', unit_cost: '100' },
          { id: 'c2', cost_code: 'CC1', sub_code: 'S2', unit: 'EA', quantity: '10', unit_cost: '100' },
          { id: 'c3', cost_code: 'CC2', sub_code: 'S3', unit: 'EA', quantity: '10', unit_cost: '100' },
        ],
        dailyRows: [
          { id: 'w1', date: '2026-11-02', cost_code: 'CC1', sub_code: 'S1', quantity: '10', labor_hours: '1' },
          { id: 'w2', date: '2026-11-02', cost_code: 'CC1', sub_code: 'S2', quantity: '10', labor_hours: '1' },
        ] }],
      pos: [], trucks: [],
    };
    for (const env of [pav, noHelp]) {
      const E2 = env.ctx.FCTReportEngine;
      const def = E2.normalizeDefinition(J(E2.STARTERS.find(st => st.id === 'customer_progress').definition));
      withData(env, pctData, () => {
        const ctx = E2.makeContext(def, cfgFor(env, pctData), { pickedIds: ['pc'], today: TODAY, now: NOW });
        const sum = rowsOf(E2.buildSectionData(def.sections[1], def, ctx))[0];
        const tot = E2.buildSectionData(def.sections[2], def, ctx).blocks[0].totals;
        const pagePct = env.helpers ? env.ctx.bidProjectPct('pc').pct : 66.6;
        const html = E2.buildReportHtml(def, ctx);
        assert(`${env.file}: bid-progress Totals % = summary % = bidProjectPct (66.6), not a flat 66.7`,
          near(tot.pct_complete, pagePct) && near(sum.pct_complete, pagePct) && near(pagePct, 66.6),
          `${tot.pct_complete} / ${sum.pct_complete} / ${pagePct}`);
        assert(`${env.file}: …so the printed report says 66.6% and never 66.7%`, /66\.6%/.test(html) && !/66\.7%/.test(html));
      });
    }

    // ── A tax-only PO line counts; the blank line still does not ──
    const poData = {
      projects: [{ id: 'po', 'project-name': 'PO Job', bidItems: [], dailyRows: [] }],
      pos: [{ id: 'P1', po_number: 'PO-1', title: 'Base', supplier: 'S', project_id: 'po', lines: [
        { id: 'a', date: '2026-11-02', qty: '20', unit_cost: '50', tax_pct: '6' },
        { id: 'b', date: '2026-11-02', qty: '', unit_cost: '', tax: '35' },
        { id: 'c', date: '2026-11-03', qty: '1250.5', unit_cost: '48.00' },
        { id: 'd', date: '2026-11-04', invoice_num: '', qty: '', unit_cost: '', tax: '', tax_pct: '' },
      ] }],
      trucks: [],
    };
    for (const env of [pav, noHelp]) {
      const E2 = env.ctx.FCTReportEngine;
      const def = E2.normalizeDefinition({ title: 'M', includeInternal: true, sections: [
        Object.assign(E2.newSection('materials'), { columns: ['date', 'qty', 'tax', 'line_total'] })] });
      const ctx = E2.makeContext(def, cfgFor(env, poData), { pickedIds: ['po'], today: TODAY, now: NOW });
      const sd = E2.buildSectionData(def.sections[0], def, ctx);
      const want = env.helpers ? env.ctx._poTotals(poData.pos[0]) : { tax: 95, total: 61119 };
      assert(`${env.file}: materials Tax and Line Total equal the PO page's totals ($95 / $61,119), blank line left out`,
        near(sd.blocks[0].totals.tax, want.tax) && near(sd.blocks[0].totals.line_total, want.total) && near(want.tax, 95)
          && rowsOf(sd).length === 3, `${sd.blocks[0].totals.tax} / ${sd.blocks[0].totals.line_total} / ${rowsOf(sd).length} rows`);
    }

    // ── Every sheet of an internal workbook says so; a customer one never ──
    {
      const intDef = allColumnsDef(PE, { includeInternal: true, title: 'Weekly Progress Update' });
      const wbI = workbook(PE.buildXlsx(intDef, mk(intDef, ['p1'])));
      const sheetParts = Object.keys(wbI.parts).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
      assert('internal workbook: every sheet carries the INTERNAL warning row and page header',
        sheetParts.length > 2 && sheetParts.every(n => {
          const cells = Object.values(readSheet(wbI.parts[n])).map(c => c.v);
          return cells.some(v => /^INTERNAL — contains cost data/.test(v || '')) && /<oddHeader>[^<]*INTERNAL/.test(wbI.parts[n]);
        }) && !wbI.bad.length, sheetParts.filter(n => !wbI.parts[n].includes('INTERNAL')).join());
      const bpc = wbI.sheets['Bid Item Progress'], head = findCell(bpc, 'Cost Code');
      assert('…the header row is still the frozen, repeated one', head
        && wbI.parts['xl/worksheets/sheet2.xml'].includes(`ySplit="${head.row}"`)
        && wbI.parts['xl/workbook.xml'].includes(`'Bid Item Progress'!$${head.row}:$${head.row}`));
      assert('…and the file name says INTERNAL', /-INTERNAL-\d{4}-\d{2}-\d{2}\.xlsx$/.test(PE.xlsxFileName(intDef, mk(intDef, ['p1']))),
        PE.xlsxFileName(intDef, mk(intDef, ['p1'])));
      const safeDef = allColumnsDef(PE, { includeInternal: false, title: 'Weekly Progress Update' });
      const wbS = workbook(PE.buildXlsx(safeDef, mk(safeDef, ['p1'])));
      assert('customer-safe workbook: no sheet mentions INTERNAL, and neither does the file name',
        Object.keys(wbS.parts).filter(n => /worksheets/.test(n)).every(n => !wbS.parts[n].includes('INTERNAL'))
          && PE.xlsxFileName(safeDef, mk(safeDef, ['p1'])) === 'Weekly-Progress-Update-2026-11-05.xlsx');
      // A role that cannot see costs cannot make an internal workbook either.
      const noCost = mk(intDef, ['p1'], null, { perm: { role: 'level1', canSeeCosts: false, canSeeFinancials: false } });
      assert('…nor for a role whose internal columns are all hidden', !/INTERNAL/.test(PE.xlsxFileName(intDef, noCost)));
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // v2: plans, charts, division rates, code filters, branding.
  // These use the engine with no page helpers unless a check is about the
  // page's own numbers; the fallbacks are shown equal to the helpers above.
  const V = bareEngine().FCTReportEngine;
  const ADMIN = { role: 'admin', canSeeCosts: true, canSeeFinancials: true, canShare: true };
  const DIVS = { paving: ['Paving', 'SY'], turf: ['Turf Management', 'SF'], kiewit: ['Kiewit Pinetree', 'SY'] };
  const vcfg = (data, extra) => Object.assign({
    division: 'paving', divisionLabel: 'Paving', areaUnit: 'SY', perm: ADMIN,
    getProjects: () => data.projects, getPurchaseOrders: () => data.pos || [], getTruckingEntries: () => data.trucks || [],
  }, extra || {});
  const divCfg = div => (DIVS[div] ? { division: div, divisionLabel: DIVS[div][0], areaUnit: DIVS[div][1] }
    : { division: undefined, divisionLabel: '', areaUnit: 'SY' });
  const vmk = (def, data, ids, opts, extra) => V.makeContext(def, vcfg(data, extra), Object.assign({ pickedIds: ids, today: TODAY, now: NOW }, opts || {}));
  const vdef = (sections, defPatch) => V.normalizeDefinition(Object.assign({ title: 'V2', sections }, defPatch || {}));
  const vsec = (type, patch) => {
    const s = Object.assign(V.newSection(type), patch || {});
    if (patch && patch.options) s.options = Object.assign(V.newSection(type).options, patch.options);
    return s;
  };
  const allCols = type => V.CATALOG[type].columns.map(c => c.key);
  const row = (date, cc, sc, qty, extra) => Object.assign({ date, cost_code: cc, sub_code: sc, quantity: String(qty),
    labor_hours: '8', employee: 'Crew A', rate: '30' }, extra || {});
  const byKey = (rows, k, v) => rows.find(r => r[k] === v);
  const wdWalk = (a, b, page) => {   // day by day, the page's own calendar
    let n = 0;
    for (let t = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)); ; t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > b) break;
      const w = new Date(t).getUTCDay();
      if (w !== 0 && w !== 6 && !page._isHoliday(d)) n++;
    }
    return n;
  };

  section('Calendar and units (v2)');
  {
    const pg = pageEngine('paving.html').ctx;
    const W = V.countWorkdays;
    assert('one-day span on a working day is 1 (the page\'s _workingDaysBetween says 0)',
      W('2026-11-04', '2026-11-04') === 1 && pg._workingDaysBetween('2026-11-04', '2026-11-04') === 0);
    assert('a one-day span on a Saturday or a holiday is 0; end before start is 0; junk is 0',
      W('2026-11-07', '2026-11-07') === 0 && W('2026-11-11', '2026-11-11') === 0 && W('2026-11-13', '2026-11-02') === 0
        && W('nope', '2026-11-02') === 0 && W('2026-02-30', '2026-03-02') === 0);
    assert('Nov 2 – Nov 13, 2026 is 9 working days (Veterans Day out); Thanksgiving week is 4',
      W('2026-11-02', '2026-11-13') === 9 && W('2026-11-23', '2026-11-27') === 4);
    assert('Oct 12 – Oct 30, 2026 is 14 (Columbus Day out); a weekend alone is 0', W('2026-10-12', '2026-10-30') === 14 && W('2026-11-07', '2026-11-08') === 0);
    // Every pair a few days apart across 2021–2028, against a walk on the page's calendar.
    let bad = [];
    let seed = 7;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 1500 && bad.length < 5; i++) {
      const a = new Date(Date.UTC(2021, 0, 1) + rnd(2900) * 86400000).toISOString().slice(0, 10);
      const b = new Date(Date.parse(a) + rnd(i % 3 ? 40 : 900) * 86400000).toISOString().slice(0, 10);
      const want = wdWalk(a, b, pg);
      if (W(a, b) !== want) bad.push(`${a}..${b}: ${W(a, b)} vs ${want}`);
      if (a < b && pg._workingDaysBetween(a, b) !== want) bad.push(`page ${a}..${b}: ${pg._workingDaysBetween(a, b)} vs ${want}`);
    }
    assert('countWorkdays equals a day-by-day walk on the page\'s holidays (1,500 spans, 2021–2028), and the page\'s count when start < end',
      !bad.length, bad.join('; '));
    assert('…including the year ends: Dec 31, 2021 (a Saturday New Year\'s is filed under 2022) and Jan 2, 2023',
      W('2021-12-27', '2022-01-07') === wdWalk('2021-12-27', '2022-01-07', pg) && W('2022-12-26', '2023-01-06') === wdWalk('2022-12-26', '2023-01-06', pg));
    const N = V.normUnit;
    assert('normUnit: trimmed upper case, TN → TON, SQ FT / SQFT → SF, everything else as is',
      N(' tn ') === 'TON' && N('Ton') === 'TON' && N('sq ft') === 'SF' && N('SQFT') === 'SF' && N('sq  ft') === 'SF'
        && N('sf') === 'SF' && N('ls') === 'LS' && N('') === '' && N(null) === '' && N('Each') === 'EACH');
  }

  section('Definitions v2: v1 in, v2 out, limits');
  {
    const v1 = { v: 1, title: 'Old', jobs: { mode: 'saved', ids: ['p1'] }, dates: { preset: 'last_week', from: '', to: '' },
      header: { preparedFor: 'Acme', preparedBy: 'Sam', intro: 'Hi', footer: 'F', showGenerated: false },
      sections: [{ id: 'a1', type: 'bid_progress', columns: ['cost_code'], labels: {}, options: { costCodes: ['Paving'] } }] };
    const n = V.normalizeDefinition(v1);
    assert('a v1 definition reads 1:1 as v2, the new fields at their defaults',
      n.v === 2 && n.title === 'Old' && n.jobs.mode === 'saved' && n.dates.preset === 'last_week' && n.header.preparedFor === 'Acme'
        && n.header.showGenerated === false && n.header.branding === 'company' && n.header.showPmContact === true
        && JSON.stringify(n.filters) === '{"costCodes":[],"subCodes":[]}' && n.sections[0].id === 'a1'
        && JSON.stringify(n.sections[0].options.costCodes) === '["Paving"]' && JSON.stringify(n.sections[0].options.subCodes) === '[]');
    const long = 'x'.repeat(61), ok60 = 'y'.repeat(60);
    const many = Array.from({ length: 230 }, (_, i) => 'SC' + i);
    const j = V.normalizeDefinition({ v: 2, description: '  A description  ', filters: { costCodes: ['A', 'A', 5, '', '  ', long, ok60, null],
      subCodes: many }, header: { branding: 'evil', showPmContact: 'no', contactName: 'n'.repeat(200), contactPhone: 7, contactEmail: 'e@x.co' },
      sections: [{ type: 'plan_vs_actual', options: { hideUnplanned: true, groupBy: 'weird', subCodes: ['Turf Install', 9, 'Turf Install'] } },
        { type: 'chart', options: { chart: 'daily_bars', basis: 'nope', height: 'tall', showPlan: false } }] });
    assert('filters: strings only, deduped, blank and over-60 entries dropped, at most 200',
      JSON.stringify(j.filters.costCodes) === JSON.stringify(['A', ok60]) && j.filters.subCodes.length === 200 && j.filters.subCodes[199] === 'SC199');
    assert('header: branding is an enum (junk → company), showPmContact off only when literally false, contact fields capped at 120',
      j.header.branding === 'company' && j.header.showPmContact === true && j.header.contactName.length === 120
        && j.header.contactPhone === '7' && j.header.contactEmail === 'e@x.co'
        && V.normalizeDefinition({ header: { branding: 'datawatch', showPmContact: false } }).header.branding === 'datawatch'
        && V.normalizeDefinition({ header: { showPmContact: false } }).header.showPmContact === false);
    assert('a description riding in the definition is kept (capped at 500); none → no key',
      j.description === '  A description  ' && !('description' in n) && V.normalizeDefinition({ description: 'z'.repeat(600) }).description.length === 500);
    assert('new sections\' options normalize: bools, selects, sub codes deduped',
      j.sections[0].options.hideUnplanned === true && j.sections[0].options.groupBy === 'none'
        && JSON.stringify(j.sections[0].options.subCodes) === '["Turf Install"]'
        && j.sections[1].options.chart === 'daily_bars' && j.sections[1].options.basis === 'pct' && j.sections[1].options.height === 'tall'
        && j.sections[1].options.showPlan === false);
    assert('normalizing a v2 definition twice changes nothing', JSON.stringify(V.normalizeDefinition(j)) === JSON.stringify(j));
    const dataSecs = ['bid_progress', 'daily_production', 'production_kpis', 'materials', 'trucking', 'change_orders', 'schedule',
      'plan_vs_actual', 'chart', 'rate_summary'];
    assert('every data section carries costCodes and subCodes options (pickers of kind costCodes / subCodes)',
      dataSecs.every(t => JSON.stringify(V.newSection(t).options.costCodes) === '[]' && JSON.stringify(V.newSection(t).options.subCodes) === '[]'
        && V.CATALOG[t].optionSpec.some(o => o.key === 'subCodes' && o.kind === 'subCodes')
        && V.CATALOG[t].optionSpec.some(o => o.key === 'costCodes' && o.kind === 'costCodes')));
    assert('new section defaults: Planned vs Actual\'s spec columns, the chart\'s measures, the division tiles',
      JSON.stringify(V.newSection('plan_vs_actual').columns) === JSON.stringify(['sub_code', 'unit', 'bid_qty', 'installed_to_date',
        'planned_rate', 'actual_rate', 'pct_of_plan', 'sched_pct', 'earned_pct', 'ahead_days', 'target_date', 'plan_status'])
      && JSON.stringify(V.newSection('chart').columns) === JSON.stringify(['installed', 'plan', 'daily_qty', 'planned_rate_line'])
      && V.newSection('chart').options.chart === 's_curve' && V.newSection('chart').options.basis === 'pct' && V.newSection('chart').options.showPlan === true
      && V.newSection('rate_summary').columns.join() === 'work_days,tons_period,tons_per_day,loads_period,tons_per_load,sf_period,sf_per_day,homes_period,homes_per_day');
    const MUST_I = { plan_vs_actual: ['units_per_crew_hr'], chart: ['crew_hours'], production_kpis: ['units_per_crew_hr', 'units_per_equip_hr'],
      rate_summary: ['avg_crew', 'tons_per_crew_hr', 'tons_per_equip_hr', 'sf_per_mh', 'mh_per_home'] };
    const MUST_SAFE = { plan_vs_actual: ['planned_rate', 'actual_rate', 'sched_pct', 'earned_pct', 'spi', 'ahead_days', 'qty_variance', 'plan_status'],
      chart: ['installed', 'plan', 'daily_qty', 'planned_rate_line'], production_kpis: ['per_load'],
      rate_summary: ['work_days', 'tons_period', 'tons_per_day', 'loads_period', 'tons_per_load', 'sf_period', 'sf_per_day', 'homes_period', 'homes_per_day'] };
    const col = (t, k) => V.CATALOG[t].columns.find(c => c.key === k);
    const wrongI = [], wrongS = [];
    Object.entries(MUST_I).forEach(([t, ks]) => ks.forEach(k => { if (!col(t, k) || !col(t, k).internal) wrongI.push(`${t}.${k}`); }));
    Object.entries(MUST_SAFE).forEach(([t, ks]) => ks.forEach(k => { if (!col(t, k) || col(t, k).internal) wrongS.push(`${t}.${k}`); }));
    assert('hours- and crew-based figures are internal; quantities, days, per-day and per-load rates, %s and plan figures are customer-safe',
      !wrongI.length && !wrongS.length, wrongI.concat(wrongS).join(', '));
    assert('signed (g) columns: qty vs plan, days ahead / behind, finish vs target, quantity change orders',
      ['qty_variance', 'ahead_days', 'forecast_vs_target'].every(k => col('plan_vs_actual', k).signed === true)
        && col('change_orders', 'qty_change').signed === true && col('plan_vs_actual', 'spi').signed === false);
    assert('division tiles are scoped: tons to paving, SF to turf, homes to kiewit; the common ones to all',
      JSON.stringify(col('rate_summary', 'tons_period').divisions) === '["paving"]' && JSON.stringify(col('rate_summary', 'sf_per_mh').divisions) === '["turf"]'
        && JSON.stringify(col('rate_summary', 'homes_per_day').divisions) === '["kiewit"]' && !col('rate_summary', 'work_days').divisions);
  }

  section('Division-scoped columns, hasInternal, starters, AI catalog, sub codes');
  {
    const def = vdef([vsec('rate_summary', { columns: allCols('rate_summary') })]);
    const intDef = vdef([vsec('rate_summary', { columns: allCols('rate_summary') })], { includeInternal: true });
    const st = (k, d, div, perm) => V.columnState('rate_summary', k, d, perm || ADMIN, div);
    assert('columnState 5th param: another division\'s column is hidden; no division at all hides every scoped column',
      st('tons_period', def, 'paving') === 'available' && st('tons_period', def, 'turf') === 'hidden' && st('sf_period', def, 'turf') === 'available'
        && st('homes_period', def, 'kiewit') === 'available' && st('tons_period', def, undefined) === 'hidden' && st('work_days', def, undefined) === 'available');
    assert('…and a scoped internal column is still locked while customer-safe',
      st('tons_per_crew_hr', def, 'paving') === 'locked' && st('tons_per_crew_hr', intDef, 'paving') === 'available' && st('tons_per_crew_hr', intDef, 'turf') === 'hidden');
    const eff = div => V.effectiveColumns(intDef.sections[0], intDef, ADMIN, div).map(c => c.key).join();
    assert('effectiveColumns by division', eff('paving') === 'work_days,avg_crew,tons_period,tons_per_day,loads_period,tons_per_load,tons_per_crew_hr,tons_per_equip_hr'
      && eff('turf') === 'work_days,avg_crew,sf_period,sf_per_day,sf_per_mh' && eff('kiewit') === 'work_days,avg_crew,homes_period,homes_per_day,mh_per_home'
      && eff(undefined) === 'work_days,avg_crew');
    const onlyTons = vdef([vsec('rate_summary', { columns: ['tons_per_crew_hr'] })], { includeInternal: true });
    assert('hasInternal: exact with a division; cautious without one (a scoped internal column counts)',
      V.hasInternal(onlyTons, ADMIN, 'paving') === true && V.hasInternal(onlyTons, ADMIN, 'turf') === false && V.hasInternal(onlyTons, ADMIN) === true
        && V.hasInternal(vdef(onlyTons.sections), ADMIN) === false);
    assert('hiddenFinancialCount does not count another division\'s columns as withheld',
      V.hiddenFinancialCount(intDef, { canSeeFinancials: false }, 'turf') === 0 && V.hiddenFinancialCount(intDef, { canSeeCosts: false }, 'turf') === 2
        && V.hiddenFinancialCount(intDef, { canSeeCosts: false }, 'paving') === 3);
    const ids = div => V.startersFor(div).map(s => s.id);
    assert('startersFor: Paving Tonnage is paving\'s alone; the rest everywhere',
      ids('paving').length === 10 && ids('turf').length === 9 && ids('kiewit').length === 9 && !ids('turf').includes('paving_tonnage')
        && ids('paving').includes('paving_tonnage') && ids(undefined).length === 9 && JSON.stringify(V.STARTERS.find(s => s.id === 'paving_tonnage').divisions) === '["paving"]');
    const st2 = id => V.STARTERS.find(s => s.id === id).definition;
    assert('new starters carry the spec\'s sections, all customer-safe',
      st2('planned_vs_actual').sections.map(s => s.type).join() === 'job_info,plan_vs_actual,chart' && st2('planned_vs_actual').sections[2].options.chart === 's_curve'
        && st2('sub_code_production').sections.map(s => s.type).join() === 'plan_vs_actual,daily_production,rate_summary,chart'
        && st2('sub_code_production').sections[3].options.chart === 'daily_bars' && JSON.stringify(st2('sub_code_production').filters.subCodes) === '[]'
        && st2('paving_tonnage').sections.map(s => s.type).join() === 'rate_summary,production_kpis,trucking'
        && st2('paving_tonnage').sections[1].columns.includes('per_load')
        && ['planned_vs_actual', 'sub_code_production', 'paving_tonnage'].every(id => !V.hasInternal(st2(id), ADMIN, 'paving') && !V.STARTERS.find(s => s.id === id).internal));
    const turfCat = V.aiCatalog('turf'), pavCat = V.aiCatalog('paving');
    const rs = c => c.sections.find(s => s.type === 'rate_summary').columns.map(x => x.key);
    assert('aiCatalog(division): every section type, no other division\'s columns, flags carried',
      turfCat.version === 2 && turfCat.sections.length === 13 && !rs(turfCat).some(k => /^tons|^homes|mh_per_home/.test(k)) && rs(turfCat).includes('sf_per_mh')
        && rs(pavCat).includes('tons_per_load') && pavCat.sections.find(s => s.type === 'job_info').columns.find(c => c.key === 'contract').financial === true
        && pavCat.sections.find(s => s.type === 'chart').columns.find(c => c.key === 'crew_hours').internal === true);
    assert('…options with their kinds and choices, presets, layouts, starters for the division; plain JSON, the same every call',
      turfCat.sections.find(s => s.type === 'chart').options.find(o => o.key === 'chart').choices.join() === 's_curve,daily_bars'
        && turfCat.sections.find(s => s.type === 'bid_progress').options.some(o => o.key === 'subCodes' && o.kind === 'subCodes')
        && turfCat.datePresets.length === 10 && turfCat.layouts.join() === 'separate,combined'
        && !turfCat.starters.some(s => s.id === 'paving_tonnage') && pavCat.starters.some(s => s.id === 'paving_tonnage')
        && JSON.stringify(V.aiCatalog('turf')) === JSON.stringify(turfCat) && JSON.stringify(JSON.parse(JSON.stringify(turfCat))) === JSON.stringify(turfCat));
    const d = fixture();
    const extra = { id: 'px', bidItems: [{ cost_code: 'Paving2', sub_code: ' base course ', description: 'second', unit: 'TN' }, { cost_code: 'X', sub_code: '' }, null] };
    const sc = J(V.subCodesFor(d.projects.slice(0, 2).concat([extra])));
    assert('subCodesFor: one entry per sub code (case-blind), first description and unit, its cost codes, sorted by code',
      JSON.stringify(sc.map(x => x.code)) === JSON.stringify(['Base Course', 'Mill 2in', 'Surface Course', 'Topsoil'])
        && sc[0].description === 'Aggregate base' && sc[0].unit === 'TON' && JSON.stringify(sc[0].costCodes) === '["Paving","Paving2"]'
        && JSON.stringify(sc[2].costCodes) === '["Paving"]' && sc[2].description === '' && JSON.stringify(V.subCodesFor(null)) === '[]',
      JSON.stringify(sc));
  }

  // ── The plan fixture: A = today = Thu Nov 5, 2026 ──
  const PV = () => ({ projects: [{ id: 'pv', 'project-name': 'Plan Job', 'job-number': 'PV1', status: 'In Progress',
    bidItems: [
      { id: 'L1', cost_code: 'Seed', sub_code: 'Topsoil', unit: 'SY', quantity: '1000', unit_cost: '1', start_date: '2026-11-02', target_date: '2026-11-13' },
      { id: 'L2', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '900', unit_cost: '10', start_date: '2026-10-26', target_date: '2026-11-06' },
      { id: 'L3', cost_code: 'Stripe', sub_code: 'Lines', unit: 'LF', quantity: '500', unit_cost: '1', start_date: '2026-10-19', target_date: '2026-10-30', is_complete: true },
      { id: 'L4', cost_code: 'Homes', sub_code: 'Set', unit: 'EA', quantity: '10', unit_cost: '1', start_date: '2026-11-16', target_date: '2026-11-20' },
      { id: 'L5', cost_code: 'Dirt', sub_code: 'Cut', unit: 'CY', quantity: '300', unit_cost: '1' },
      { id: 'L6', cost_code: 'Sod', sub_code: 'Lay', unit: 'SF', quantity: '2000', unit_cost: '1', start_date: '2026-10-12', target_date: '2026-10-30' },
      { id: 'L7', cost_code: 'Pave', sub_code: 'Surface', unit: 'TON', quantity: '1000', unit_cost: '1', planned_rate: '100' },
      { id: 'L8', cost_code: 'Sign', sub_code: 'Post', unit: 'EA', quantity: '4', unit_cost: '1', start_date: '2026-11-04', target_date: '2026-11-04' },
    ],
    dailyRows: [
      row('2026-11-02', 'Seed', 'Topsoil', 100), row('2026-11-03', 'Seed', 'Topsoil', 150), row('2026-11-04', 'Seed', 'Topsoil', 200),
      row('2026-10-27', 'Pave', 'Base', 100), row('2026-10-29', 'Pave', 'Base', 80),
      row('2026-10-19', 'Stripe', 'Lines', 200), row('2026-10-20', 'Stripe', 'Lines', 200), row('2026-10-21', 'Stripe', 'Lines', 100),
      row('2026-11-03', 'Dirt', 'Cut', 50),
      row('2026-10-13', 'Sod', 'Lay', 500), row('2026-10-14', 'Sod', 'Lay', 500),
      row('2026-10-28', 'Pave', 'Surface', 120), row('2026-10-29', 'Pave', 'Surface', 90), row('2026-11-02', 'Pave', 'Surface', 110),
      row('2026-11-04', 'Sign', 'Post', 2),
    ] }] });

  section('Planned vs actual — worked by hand');
  {
    const data = PV();
    const def = vdef([vsec('plan_vs_actual', { columns: allCols('plan_vs_actual') })], { includeInternal: true });
    const sd = V.buildSectionData(def.sections[0], def, vmk(def, data, ['pv']));
    const rows = rowsOf(sd);
    const L = sc => byKey(rows, 'sub_code', sc);
    const l1 = L('Topsoil'), l2 = L('Base'), l3 = L('Lines'), l4 = L('Set'), l5 = L('Cut'), l6 = L('Lay'), l7 = L('Surface'), l8 = L('Post');
    assert('every bid item is listed, idle ones too, in bid order', rows.map(r => r.sub_code).join() === 'Topsoil,Base,Lines,Set,Cut,Lay,Surface,Post');
    // L1: Nov 2 – Nov 13 is 9 working days (Veterans Day out) → 1,000 ÷ 9 a day.
    // To Nov 5: 4 days elapsed → scheduled 4/9 = 44.4%; 450 in = 45% earned.
    assert('L1 planned / day = 1,000 ÷ 9 working days; actual 450 ÷ 3 days = 150; 135% of plan',
      near(l1.planned_rate, 1000 / 9) && l1.actual_rate === 150 && l1.actual_rate_jtd === 150 && near(l1.pct_of_plan, 135), J(l1));
    assert('L1 scheduled 44.4% (4 of 9 days), earned 45%, pace vs plan 1.01, 5.56 ahead of the planned quantity',
      near(l1.sched_pct, 400 / 9) && l1.earned_pct === 45 && l1.spi === 1.01 && near(l1.qty_variance, 450 - 4000 / 9));
    assert('L1 ahead = 0.45 × 9 − 4 = 0.05 → under half a day: 0, On track', l1.ahead_days === 0 && l1.plan_status === 'On track');
    assert('L1 needed / day = 550 left ÷ 6 working days to Nov 13 (Nov 5, 6, 9, 10, 12, 13)', near(l1.required_rate, 550 / 6));
    assert('L1 projected finish: 550 at 150 a day → 4 days → Thu Nov 12 (Veterans Day skipped); 1 day before target',
      l1.projected_finish === '2026-11-12' && l1.forecast_vs_target === 1 && l1.start_date === '2026-11-02' && l1.target_date === '2026-11-13'
        && l1.plan_source === 'Bid item dates');
    assert('L1 units per crew-hour (internal): 450 over three 8-hour shifts = 18.75', l1.units_per_crew_hr === 18.75);
    // L2: Oct 26 – Nov 6 = 10 days → 90 a day; 9 elapsed → scheduled 90%; 180 in = 20%.
    assert('L2 behind: scheduled 90%, earned 20%, pace 0.22, ahead 0.2 × 10 − 9 = −7 → Behind',
      l2.planned_rate === 90 && l2.sched_pct === 90 && l2.earned_pct === 20 && l2.spi === 0.22 && l2.ahead_days === -7
        && l2.plan_status === 'Behind' && near(l2.qty_variance, 180 - 810));
    assert('L2 needs 720 over 2 days = 360 a day; at 90 a day it finishes Wed Nov 18, 7 working days late',
      l2.required_rate === 360 && l2.projected_finish === '2026-11-18' && l2.forecast_vs_target === -7, J(l2));
    // L3: complete on Oct 21 against a 10-day plan to Oct 30 → 10 − 3 = 7 ahead.
    assert('L3 complete: ahead = 10 planned days − 3 used (Oct 19–21) = +7; nothing needed, no finish',
      l3.plan_status === 'Complete' && l3.ahead_days === 7 && l3.earned_pct === 100 && l3.sched_pct === 100 && l3.spi === 1
        && l3.required_rate === null && l3.projected_finish === null && l3.forecast_vs_target === null);
    assert('L4 not started: starts Nov 16, no work → Not started, scheduled 0, no pace; planned 10 ÷ 5 = 2 a day',
      l4.plan_status === 'Not started' && l4.sched_pct === 0 && l4.spi === null && l4.ahead_days === 0 && l4.planned_rate === 2
        && near(l4.required_rate, 10 / 11));
    assert('L5 no dates, no rate: Not scheduled — no plan figures, but its earned % is still its % complete',
      l5.plan_status === 'Not scheduled' && l5.planned_rate === null && l5.sched_pct === null && l5.spi === null && l5.ahead_days === null
        && l5.plan_source === null && l5.target_date === null && near(l5.earned_pct, 50 / 3) && l5.actual_rate === 50);
    // L6: Oct 12 (Columbus Day) – Oct 30 = 14 days; 18 elapsed to Nov 5; half in.
    assert('L6 past its target and not done: Behind (past target), nothing needed / day; ahead 7 − 18 = −11',
      l6.plan_status === 'Behind (past target)' && l6.required_rate === null && l6.ahead_days === -11 && l6.sched_pct === 100 && l6.spi === 0.5);
    // L7: 100 a day typed; starts on its first day worked (Oct 28); 1,000 ÷ 100 = 10
    // days → Oct 28 … Nov 10. Production: 320 in on 3 days vs 300 planned → +0.2 day.
    assert('L7 rate plan: Planned / Day as typed, start = first day worked, target = the 10th working day (Nov 10)',
      l7.planned_rate === 100 && l7.start_date === '2026-10-28' && l7.target_date === '2026-11-10' && l7.plan_source === 'Planned per day');
    assert('L7 scheduled 7/10 = 70%, earned 32%; ahead in days of planned output (320 − 100 × 3) ÷ 100 = 0.2 → 0, On track',
      l7.sched_pct === 70 && l7.earned_pct === 32 && l7.spi === 0.46 && l7.ahead_days === 0 && l7.plan_status === 'On track');
    assert('L7 needs 680 over 4 days = 170; at 106.7 a day 7 days → Tue Nov 17, 4 working days past Nov 10',
      l7.required_rate === 170 && l7.projected_finish === '2026-11-17' && l7.forecast_vs_target === -4, J(l7));
    assert('L8 one-day plan (start = target = Nov 4): W = 1, so 4 a day — the page\'s count would give it no rate',
      l8.planned_rate === 4 && l8.sched_pct === 100 && l8.earned_pct === 50 && l8.ahead_days === -1.5 && l8.plan_status === 'Behind (past target)');
    assert('footnote: the plan basis, N of M items without a plan, and the as-of date',
      JSON.stringify(sd.blocks[0].notes) === JSON.stringify(['Planned figures use each bid item\'s Start and Target dates (or the job end date / Planned per day). '
        + '1 of 8 items have no plan. As of Nov 5, 2026.']), J(sd.blocks[0].notes));
    const hid = vdef([vsec('plan_vs_actual', { options: { hideUnplanned: true, hideComplete: true } })]);
    assert('hideUnplanned drops Not scheduled, hideComplete drops Complete; the footnote still counts every item',
      rowsOf(V.buildSectionData(hid.sections[0], hid, vmk(hid, data, ['pv']))).map(r => r.sub_code).join() === 'Topsoil,Base,Set,Lay,Surface,Post'
        && /1 of 8 items have no plan/.test(V.buildSectionData(hid.sections[0], hid, vmk(hid, data, ['pv'])).blocks[0].notes[0]));
    // As of a past range's end: last month ends Oct 31.
    const lm = vdef(def.sections, { includeInternal: true, dates: { preset: 'last_month' } });
    const lr = rowsOf(V.buildSectionData(lm.sections[0], lm, vmk(lm, data, ['pv'])));
    const lb = byKey(lr, 'sub_code', 'Base');
    assert('a past range measures to its end: L2 at Oct 31 is 5 of 10 days = 50% scheduled, 2 − 5 = −3 → At risk',
      lb.sched_pct === 50 && lb.earned_pct === 20 && lb.ahead_days === -3 && lb.plan_status === 'At risk' && /As of Oct 31, 2026/.test(
        V.buildSectionData(lm.sections[0], lm, vmk(lm, data, ['pv'])).blocks[0].notes[0]));
    const tw = vdef(def.sections, { includeInternal: true, dates: { preset: 'this_week' } });
    assert('a range ending in the future (this week) measures to today, not Sunday',
      byKey(rowsOf(V.buildSectionData(tw.sections[0], tw, vmk(tw, data, ['pv']))), 'sub_code', 'Topsoil').sched_pct === l1.sched_pct);
    // Fully installed but never marked complete reads Complete, measured from its last day.
    const full = PV();
    full.projects[0].dailyRows.push(row('2026-11-05', 'Sign', 'Post', 2));
    const fp = byKey(rowsOf(V.buildSectionData(def.sections[0], def, vmk(def, full, ['pv']))), 'sub_code', 'Post');
    assert('a line with every unit in (not marked complete) is done: Complete, measured from its last day — 1 planned day − 2 used = −1',
      fp.plan_status === 'Complete' && fp.earned_pct === 100 && fp.ahead_days === -1 && fp.required_rate === null, J(fp));
  }

  section('Planned vs actual — totals, job dates, schedule source, combined');
  {
    const data = { projects: [
      { id: 'pt', 'project-name': 'Totals Job', status: 'In Progress', bidItems: [
        { id: 'T1', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-13' },
        { id: 'T2', cost_code: 'Pave', sub_code: 'Base', unit: 'tn', quantity: '500', unit_cost: '20', start_date: '2026-10-26', target_date: '2026-11-06' },
      ], dailyRows: [row('2026-11-02', 'Pave', 'Top', 50), row('2026-10-26', 'Pave', 'Base', 250), row('2026-10-27', 'Pave', 'Base', 250)] },
      { id: 'pj', 'project-name': 'Dates Job', status: 'In Progress', 'start-date': '2026-10-26', 'end-date': '2026-11-13', bidItems: [
        { id: 'J1', cost_code: 'Grade', sub_code: 'Fine', unit: 'SY', quantity: '100', unit_cost: '1' },
        { id: 'J2', cost_code: 'Grade', sub_code: 'Rough', unit: 'SY', quantity: '100', unit_cost: '1', is_complete: true },
      ], dailyRows: [row('2026-10-27', 'Grade', 'Fine', 40)] },
      { id: 'pe', 'project-name': 'End Job', 'end-date': '2026-11-13', bidItems: [
        { id: 'E1', cost_code: 'Seed', sub_code: 'Mix', unit: 'SY', quantity: '900', unit_cost: '1', start_date: '2026-11-02' },
      ], dailyRows: [] },
    ] };
    const def = vdef([vsec('plan_vs_actual', { columns: allCols('plan_vs_actual') })], { includeInternal: true });
    const sd = V.buildSectionData(def.sections[0], def, vmk(def, data, ['pt', 'pj', 'pe']));
    const t = sd.blocks[0].totals, r = rowsOf(sd, 0);
    // Weights = bid $: 10,000 each. Scheduled (44.4 + 90) / 2 = 67.2; earned (5 + 100) / 2 = 52.5.
    assert('totals weigh lines by bid dollars: scheduled 67.2%, earned 52.5%, pace 0.78',
      near(t.sched_pct, (400 / 9 + 90) / 2) && near(t.earned_pct, 52.5) && t.spi === 0.78, J(t));
    assert('totals ahead = (52.5 − 67.2)/100 × 14 working days (Oct 26 – Nov 13) = −2.06 → −2 → At risk',
      t.ahead_days === -2 && t.plan_status === 'At risk' && t.start_date === '2026-10-26' && t.target_date === '2026-11-13');
    assert('TON and TN are one unit: rates roll up — planned 1,500 ÷ 14 a day, actual 550 ÷ 3 days, % of plan',
      t.unit === 'TON' && t.bid_qty === 1500 && t.installed_to_date === 550 && near(t.planned_rate, 1500 / 14) && near(t.actual_rate, 550 / 3)
        && near(t.pct_of_plan, (550 / 3) / (1500 / 14) * 100), J(t));
    assert('totals qty vs plan (50 − 444.4) + (500 − 450); needed 950 ÷ 6 days; finish Fri Dec 4 (Thanksgiving out), 14 days late',
      near(t.qty_variance, (50 - 4000 / 9) + 50) && near(t.required_rate, 950 / 6) && t.projected_finish === '2026-12-04' && t.forecast_vs_target === -14, J(t));
    assert('…the lines: T1 −3.55 → −3.5 Behind; T2 all in → Complete, 10 − 2 = +8',
      byKey(r, 'sub_code', 'Top').ahead_days === -3.5 && byKey(r, 'sub_code', 'Top').plan_status === 'Behind'
        && byKey(r, 'sub_code', 'Base').plan_status === 'Complete' && byKey(r, 'sub_code', 'Base').ahead_days === 8);
    const jt = sd.blocks[1].totals;
    // No line planned; the job runs Oct 26 – Nov 13 (14 days), 9 elapsed → 64.3%;
    // earned = the bid-$ roll-up of 40% and a completed line = 70%.
    assert('a job with no planned line but start and end dates: measured on Job dates',
      jt.plan_source === 'Job dates' && near(jt.sched_pct, 900 / 14) && near(jt.earned_pct, 70) && jt.spi === 1.09
        && jt.ahead_days === 1 && jt.plan_status === 'On track' && jt.start_date === '2026-10-26' && rowsOf(sd, 1)[0].plan_status === 'Not scheduled', J(jt));
    const e1 = rowsOf(sd, 2)[0];
    assert('typed start, no target: the job\'s end date stands in (bid + job end): Nov 2 – Nov 13 = 9 days → 100 a day',
      e1.plan_source === 'Bid item start + job end' && e1.target_date === '2026-11-13' && e1.planned_rate === 100 && e1.sched_pct === 400 / 9);
    // Combined: per-job roll-ups as subtotals, a grand total over both.
    const comb = vdef(def.sections, { includeInternal: true, layout: 'combined' });
    const cs = V.buildSectionData(comb.sections[0], comb, vmk(comb, data, ['pt', 'pj']));
    const g = cs.blocks[0].groups;
    // The grand total counts both jobs, each on its own basis, weighed by bid
    // dollars (20,000 and 200): Scheduled (20,000 × 67.2 + 200 × 64.3) ÷ 20,200;
    // days (20,000 × −2.06 + 200 × 0.8) ÷ 20,200 = −2.03 → −2; no single basis.
    const gt = cs.blocks[0].totals;
    assert('combined: a group per job, each rolled up like its own totals; one grand total over both jobs, each on its own basis',
      g.map(x => x.label).join('|') === 'Totals Job|Dates Job' && near(g[0].subtotal.sched_pct, t.sched_pct) && g[0].subtotal.ahead_days === -2
        && g[1].subtotal.plan_source === 'Job dates' && gt && cs.columns[0].key === '_job'
        && near(gt.sched_pct, (20000 * t.sched_pct + 200 * jt.sched_pct) / 20200) && near(gt.earned_pct, (20000 * t.earned_pct + 200 * jt.earned_pct) / 20200)
        && gt.ahead_days === -2 && gt.plan_source === null, J({ subs: g.map(x => x.subtotal), gt }));
    // A typed rate is the plan: the roll-up and the chart's planned line read
    // the rate the line shows, not its bid quantity spread over its dates.
    {
      const rd = { projects: [
        { id: 'ra', 'project-name': 'Rate A', bidItems: [
          { id: 'RA1', cost_code: 'Turf', sub_code: 'Install', unit: 'SF', quantity: '20000', unit_cost: '1', planned_rate: '2500',
            start_date: '2026-10-26', target_date: '2026-11-20' }],
        dailyRows: [row('2026-11-02', 'Turf', 'Install', 2000), row('2026-11-04', 'Turf', 'Install', 3000)] },
        { id: 'rb', 'project-name': 'Rate B', bidItems: [
          { id: 'RB1', cost_code: 'Turf', sub_code: 'Install', unit: 'SF', quantity: '12000', unit_cost: '1', planned_rate: '1000',
            start_date: '2026-10-28', target_date: '2026-12-04' }],
        dailyRows: [row('2026-11-03', 'Turf', 'Install', 1500)] },
      ] };
      const rdates = { preset: 'custom', from: '2026-10-26', to: '2026-11-05' };
      const rdef = vdef([vsec('plan_vs_actual', { columns: ['sub_code', 'planned_rate', 'actual_rate', 'pct_of_plan'] })], { dates: rdates });
      const one = V.buildSectionData(rdef.sections[0], rdef, vmk(rdef, rd, ['ra']));
      const t1 = one.blocks[0].totals, l1 = rowsOf(one, 0)[0];
      assert('a lone "Planned per day" line: Totals read its own rate — 2,500 planned (not 20,000 over its 19 days), 2,500 actual, 100%',
        l1.planned_rate === 2500 && near(t1.planned_rate, 2500) && t1.actual_rate === 2500 && near(t1.pct_of_plan, 100) && near(l1.pct_of_plan, 100),
        JSON.stringify({ l1, t1 }));
      const rcomb = vdef(rdef.sections, { layout: 'combined', dates: rdates });
      const gt = V.buildSectionData(rcomb.sections[0], rcomb, vmk(rcomb, rd, ['ra', 'rb'])).blocks[0].totals;
      assert('combined: the grand total weighs each job\'s planned rate by the days it worked — (2,500×2 + 1,000×1) ÷ 3 = 2,000 a day '
        + 'against 6,500 ÷ 3 job-days actual: 108.3% (the lines read 100% and 150%)',
        near(gt.planned_rate, 2000) && near(gt.actual_rate, 6500 / 3) && near(gt.pct_of_plan, 6500 / 6000 * 100), JSON.stringify(gt));
      const rnone = { projects: rd.projects.map(p => Object.assign({}, p, { dailyRows: [] })) };
      const gt0 = V.buildSectionData(rcomb.sections[0], rcomb, vmk(rcomb, rnone, ['ra', 'rb'])).blocks[0].totals;
      assert('…with no work yet, the jobs\' planned rates are averaged ((2,500 + 1,000) ÷ 2) and there is no % of plan',
        near(gt0.planned_rate, 1750) && gt0.pct_of_plan === null && gt0.actual_rate === null, JSON.stringify(gt0));
      const rbars = vdef([vsec('chart', { options: { chart: 'daily_bars' } })], { dates: rdates });
      const bch = V.buildSectionData(rbars.sections[0], rbars, vmk(rbars, rd, ['ra'])).blocks[0].charts[0];
      assert('…and the daily bars\' planned line is the 2,500 a day the line shows',
        near(bch.rate, 2500) && bch.drawPlan && bch.bars.length > 0 && bch.bars.every(b => near(b.plan, 2500)), JSON.stringify({ rate: bch.rate }));
    }
    // The Construction Schedule (turf / Kiewit): tasks matched on _bidCsKey.
    const csData = { projects: [{ id: 'pc', 'project-name': 'Turf Job', bidItems: [
      { id: 'C1', cost_code: 'Turf', sub_code: 'Install', unit: 'SF', quantity: '1000', unit_cost: '1' },
      { id: 'C2', cost_code: 'Turf', sub_code: '', unit: 'LF', quantity: '500', unit_cost: '1' },
      { id: 'C3', cost_code: 'Seed', sub_code: 'Mix', unit: 'SY', quantity: '100', unit_cost: '1', start_date: '2026-11-09', target_date: '2026-11-10' },
      { id: 'C4', cost_code: 'Edge', sub_code: 'Trim', unit: 'LF', quantity: '10', unit_cost: '1' },
    ], dailyRows: [] }] };
    const tasks = [
      { id: 'a', kind: 'task', code: 'Turf', subcode: 'Install', start: '11/2/26', end: '2026-11-13' },
      { id: 'b', kind: 'task', code: ' turf', subcode: 'INSTALL ', start: '2026-10-30', end: '11/12/26' },
      { id: 'c', kind: 'task', code: 'Turf', subcode: '', start: '2026-11-02', end: '2026-11-06' },
      { id: 'd', kind: 'task', code: 'Seed', subcode: 'Mix', start: '2026-10-01', end: '2026-10-30' },
      { id: 'e', kind: 'divider', code: 'Edge', subcode: 'Trim', start: '2026-11-02', end: '2026-11-06' },
      { id: 'f', kind: 'task', code: 'Edge', subcode: 'Trim', start: '2026-11-02', end: '' },
      { id: 'g', kind: 'task', code: 'Edge', subcode: 'Trim', start: '2026-11-10', end: '2026-11-02' },
    ];
    const csDef = vdef([vsec('plan_vs_actual', { columns: ['sub_code', 'planned_rate', 'start_date', 'target_date', 'plan_source', 'plan_status'] })]);
    const asked = [];
    const csRows = getCs => rowsOf(V.buildSectionData(csDef.sections[0], csDef, vmk(csDef, csData, ['pc'], null,
      Object.assign(divCfg('turf'), { getConSchedule: getCs }))));
    const cr = csRows(id => { asked.push(id); return tasks; });
    assert('schedule plan: tasks on the same code / sub code (trimmed, case-blind, M/D/YY read) → earliest start to latest end',
      cr[0].start_date === '2026-10-30' && cr[0].target_date === '2026-11-13' && cr[0].planned_rate === 100 && cr[0].plan_source === 'Construction schedule', J(cr[0]));
    assert('…a code-only task plans the code-only bid item; typed bid dates win over the schedule; dividers, half-dated and reversed tasks ignored',
      cr[1].planned_rate === 100 && cr[1].target_date === '2026-11-06' && cr[2].plan_source === 'Bid item dates' && cr[2].planned_rate === 50
        && cr[3].plan_source === null && cr[3].plan_status === 'Not scheduled');
    assert('…asked once per job; a { rows } object works; a throwing or missing getter means no schedule plan',
      asked.join() === 'pc' && csRows(() => ({ rows: tasks }))[0].planned_rate === 100 && csRows(() => { throw new Error('x'); })[0].plan_source === null
        && csRows(undefined)[0].plan_source === null);
    // Paving's _schedCalcRow on the same dates: the planned pace is the page's.
    for (const file of ['paving.html', 'tracker.html', 'kiewit-pinetree.html']) {
      const pg = pageEngine(file);
      const items = [
        { id: 'P1', cost_code: 'A', sub_code: '1', unit: 'SY', quantity: '1000', start_date: '2026-11-02', target_date: '2026-11-13',
          change_orders: [{ qty_delta: '80' }] },
        { id: 'P2', cost_code: 'A', sub_code: '2', unit: 'TON', quantity: '5000', start_date: '2026-11-20', target_date: '2026-12-31' },
        { id: 'P3', cost_code: 'A', sub_code: '3', unit: 'LF', quantity: '777', start_date: '2027-06-28', target_date: '2027-07-09' },
        { id: 'P4', cost_code: 'A', sub_code: '4', unit: 'EA', quantity: '12', start_date: '2026-12-28', target_date: '2027-01-08' },
        { id: 'P5', cost_code: 'A', sub_code: '5', unit: 'CY', quantity: '450', start_date: '2026-11-02' },
        { id: 'P6', cost_code: 'A', sub_code: '6', unit: 'EA', quantity: '4', start_date: '2026-11-04', target_date: '2026-11-04' },
      ];
      const pd = { projects: [{ id: 'pp', 'project-name': 'Pace', 'end-date': '2026-12-15', bidItems: items, dailyRows: [] }] };
      const pdef = vdef([vsec('plan_vs_actual', { columns: ['sub_code', 'planned_rate', 'plan_source'] })]);
      const er = rowsOf(pg.ctx.FCTReportEngine.buildSectionData(pdef.sections[0], pdef,
        pg.ctx.FCTReportEngine.makeContext(pdef, cfgFor(pg, pd), { pickedIds: ['pp'], today: TODAY, now: NOW })));
      const bad = [];
      items.forEach((b, i) => {
        const pace = pg.ctx._schedCalcRow(b, {}, null, '2026-12-15').plannedPace;
        if (b.id === 'P6') { if (pace !== null || er[i].planned_rate !== 4) bad.push(`P6: page ${pace}, engine ${er[i].planned_rate}`); }
        else if (!near(er[i].planned_rate, pace, 1e-9)) bad.push(`${b.id}: ${er[i].planned_rate} vs page ${pace}`);
      });
      assert(`${file}: Planned / Day equals the page's _schedCalcRow plannedPace (holidays, change orders, job end as deadline); a one-day plan is the deliberate exception`,
        !bad.length && er[4].plan_source === 'Bid item start + job end', bad.join('; '));
    }
  }

  section('Planned vs actual — Totals measure the planned lines (review fixes)');
  {
    const pva = (cols, defPatch, sec) => vdef([vsec('plan_vs_actual', Object.assign({ columns: cols }, sec || {}))], defPatch);
    const totOf = (def, data, ids) => J(V.buildSectionData(def.sections[0], def, vmk(def, data, ids)).blocks[0].totals);
    const subOf = (def, data, ids) => J(V.buildSectionData(def.sections[0], def, vmk(def, data, ids)).blocks[0].groups.map(g => g.subtotal));
    // Every planned line finished before its target; an undated LS line
    // (mobilization, kept open to closeout) is still open.
    const ls = { id: 'm', cost_code: 'General', sub_code: 'Mobilization', unit: 'LS', quantity: '1', unit_cost: '5000' };
    const F1 = (withLs, topOpen) => ({ projects: [{ id: 'fa', 'project-name': 'A', status: 'In Progress', bidItems: (withLs ? [ls] : []).concat([
      { id: 'x1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '500', unit_cost: '10', start_date: '2026-10-19', target_date: '2026-10-30' },
      { id: 'x2', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '400', unit_cost: '10', start_date: '2026-10-26', target_date: '2026-11-03' }]),
    dailyRows: [row('2026-10-19', 'Pave', 'Base', 250), row('2026-10-20', 'Pave', 'Base', 250), row('2026-10-26', 'Pave', 'Top', 200)]
      .concat(topOpen ? [] : [row('2026-10-27', 'Pave', 'Top', 200)]) },
    { id: 'fb', 'project-name': 'B', status: 'In Progress', bidItems: [
      { id: 'y1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '500', unit_cost: '10', start_date: '2026-10-19', target_date: '2026-11-20' }],
    dailyRows: [row('2026-10-19', 'Pave', 'Base', 100)] }] });
    const c1 = ['sub_code', 'sched_pct', 'earned_pct', 'ahead_days', 'target_date', 'plan_status'];
    const t1 = totOf(pva(c1), F1(true), ['fa']);
    assert('every planned line done before its target, an undated LS line still open: Totals read On track, not Behind (past target)',
      t1.plan_status === 'On track' && t1.sched_pct === 100 && t1.earned_pct === 100 && t1.ahead_days === 0, JSON.stringify(t1));
    const s1 = subOf(pva(c1, { layout: 'combined' }), F1(true), ['fa', 'fb']);
    assert('…and the combined layout\'s job subtotal says the same', s1[0].plan_status === 'On track', JSON.stringify(s1));
    assert('…without the LS line, Complete as before', totOf(pva(c1), F1(false), ['fa']).plan_status === 'Complete');
    assert('…a planned line still open past its own target is Behind (past target), as before',
      totOf(pva(c1), F1(true, true), ['fa']).plan_status === 'Behind (past target)');
    const jd = { projects: [{ id: 'jd', 'project-name': 'Dates', status: 'In Progress', 'start-date': '2026-10-01', 'end-date': '2026-10-30', bidItems: [
      { id: 'j1', cost_code: 'Grade', sub_code: 'Fine', unit: 'SY', quantity: '100', unit_cost: '1' }], dailyRows: [row('2026-10-05', 'Grade', 'Fine', 40)] }] };
    const tj = totOf(pva(c1.concat(['plan_source'])), jd, ['jd']);
    assert('…and a job measured on its dates, past its end with work open, is Behind (past target)',
      tj.plan_source === 'Job dates' && tj.plan_status === 'Behind (past target)', JSON.stringify(tj));
    // One small planned line slipped past its own target while the job's
    // Totals target (the latest target) is weeks away and the job is ahead:
    // the slipped line reads Behind (past target), the Totals do not.
    const F3 = { projects: [{ id: 'f3', 'project-name': 'Slip', status: 'In Progress', bidItems: [
      { id: 'c1', cost_code: 'Curb', sub_code: 'Curb', unit: 'TON', quantity: '100', unit_cost: '10', start_date: '2026-10-26', target_date: '2026-11-03' },
      { id: 'c2', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '10000', unit_cost: '50', start_date: '2026-10-26', target_date: '2026-12-18' }],
    dailyRows: [row('2026-10-26', 'Curb', 'Curb', 50), row('2026-10-27', 'Curb', 'Curb', 45)]
      .concat(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
        .map(dt => row(dt, 'Pave', 'Base', 500))) },
    { id: 'f3b', 'project-name': 'Steady', status: 'In Progress', bidItems: [
      { id: 'c3', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-13' }],
    dailyRows: [row('2026-11-02', 'Pave', 'Base', 150), row('2026-11-03', 'Pave', 'Base', 150), row('2026-11-04', 'Pave', 'Base', 150)] }] };
    const c3 = ['sub_code', 'sched_pct', 'earned_pct', 'ahead_days', 'required_rate', 'target_date', 'forecast_vs_target', 'plan_status'];
    const d3 = V.buildSectionData(pva(c3).sections[0], pva(c3), vmk(pva(c3), F3, ['f3']));
    const curb3 = rowsOf(d3).find(r => r.sub_code === 'Curb'), t3 = J(d3.blocks[0].totals);
    assert('one small line past its own target on a job ahead of a later Totals target: the line is Behind (past target), the Totals are On track',
      curb3 && curb3.plan_status === 'Behind (past target)' && t3.plan_status === 'On track' && t3.required_rate !== null
        && t3.target_date === '2026-12-18' && t3.ahead_days > 0, JSON.stringify({ curb3, t3 }));
    const g3 = V.buildSectionData(pva(c3, { layout: 'combined' }).sections[0], pva(c3, { layout: 'combined' }), vmk(pva(c3, { layout: 'combined' }), F3, ['f3', 'f3b']));
    const gt3 = J(g3.blocks[0].totals), gs3 = J(g3.blocks[0].groups.map(g => g.subtotal));
    assert('…and the combined layout\'s job subtotal and grand total over it and an on-track job are not Behind (past target)',
      gt3.plan_status !== 'Behind (past target)' && gs3[0] && gs3[0].plan_status !== 'Behind (past target)', JSON.stringify({ gt3, gs3 }));

    // A Plan / Day line whose crew started after its Target (or, with no
    // Target, after the job's end date): Planned vs Actual counts it as
    // planned, so the S-curve, the daily bars' planned line and the Totals'
    // Planned / Day count it too — one span (its start day) for all of them.
    // That day counts as one even when it is a Saturday, a Sunday or a
    // holiday (a weekend crew, a holiday start): the span has no working day
    // of its own, and every consumer counts it as the day it is.
    for (const [first, surfDays, iToday, sFrom, sTo] of [
      ['a Monday', ['2026-10-19', '2026-10-20', '2026-10-21'], '2026-11-06', '2026-10-12', '2026-10-30'],
      ['a Saturday', ['2026-10-17', '2026-10-19', '2026-10-20'], '2026-11-06', '2026-10-12', '2026-10-30'],
      ['Veterans Day (a weekday holiday)', ['2026-11-11', '2026-11-12', '2026-11-13'], '2026-11-20', '2026-11-09', '2026-11-20']])
    for (const [why, target, jobEnd] of [['a typed Target before the first work day', '2026-10-09', '2026-12-18'],
      ['no Target, the job end date before the first work day', '', '2026-10-09']]) {
      const INV = { projects: [{ id: 'inv', 'project-name': 'Main St', status: 'In Progress', 'start-date': '2026-10-01', 'end-date': jobEnd, bidItems: [
        { id: 'ia', cost_code: '300', sub_code: 'MILL', unit: 'SY', quantity: '14000', unit_cost: '3', start_date: '2026-10-05', target_date: '2026-10-13' },
        Object.assign({ id: 'ib', cost_code: '400', sub_code: 'SURF', unit: 'TON', quantity: '2400', unit_cost: '95', planned_rate: '400' }, target ? { target_date: target } : {})],
      dailyRows: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'].map(dt => row(dt, '300', 'MILL', 2000))
        .concat(surfDays.map(dt => row(dt, '400', 'SURF', 350))) }] };
      const iCols = ['sub_code', 'planned_rate', 'actual_rate', 'pct_of_plan', 'sched_pct', 'earned_pct', 'ahead_days', 'plan_status'];
      const idef = vdef([vsec('plan_vs_actual', { columns: iCols }), vsec('chart', { columns: ['installed', 'plan'], options: { chart: 's_curve', basis: 'pct' } })],
        { dates: { preset: 'job_to_date', from: '', to: '' } });
      const ictx = vmk(idef, INV, ['inv'], { today: iToday });
      const itot = J(V.buildSectionData(idef.sections[0], idef, ictx).blocks[0].totals);
      const isc = J(V.buildSectionData(idef.sections[1], idef, ictx).blocks[0].charts[0]);
      const iat = isc.points.find(q => q.date === isc.asOf) || isc.points[isc.points.length - 1];
      assert(`late start (${why}, first work day ${first}): the S-curve at the as-of day reads PvA Totals' earned and scheduled %, both items covered`,
        iat && near(iat.inst, itot.earned_pct, 1e-6) && near(iat.plan, itot.sched_pct, 1e-6) && !isc.captions.some(c => /Covers the 1 of 2/.test(c)),
        JSON.stringify({ at: iat, tot: itot, cap: isc.captions }));
      const sdef = vdef([vsec('plan_vs_actual', { columns: iCols }), vsec('chart', { columns: ['daily_qty', 'planned_rate_line'], options: { chart: 'daily_bars' } })],
        { dates: { preset: 'custom', from: sFrom, to: sTo }, filters: { costCodes: [], subCodes: ['SURF'] } });
      const sctx = vmk(sdef, INV, ['inv'], { today: iToday });
      const sd0 = V.buildSectionData(sdef.sections[0], sdef, sctx);
      const sline = J(rowsOf(sd0)[0]), stot = J(sd0.blocks[0].totals);
      const sbars = J(V.buildSectionData(sdef.sections[1], sdef, sctx).blocks[0].charts[0]);
      assert(`…scoped to that line alone: its Totals read its Planned / Day 400 and 87.5% of plan, and the daily bars draw the 400 planned line`,
        sline.planned_rate === 400 && stot.planned_rate === 400 && near(stot.pct_of_plan, 87.5) && sbars.rate === 400 && sbars.drawPlan === true,
        JSON.stringify({ sline, stot, rate: sbars.rate, draw: sbars.drawPlan }));
      assert(`…its Days Ahead / Behind has a value, on the line and in its Totals${target ? ' (typed Target)' : ''}`,
        sline.ahead_days !== null && stot.ahead_days !== null && (target ? true : stot.ahead_days === sline.ahead_days),
        JSON.stringify({ sline, stot }));
    }

    // A Plan / Day line planned for one weekend day (start = target = a
    // Saturday) beside a dated line: the S-curve covers both lines, as the
    // Totals do, and ends on the Totals' figures; the line's own Days
    // Ahead / Behind is not blank; and the Totals read as they do with the
    // weekend line moved to the Friday.
    {
      const WK = day => ({ projects: [{ id: 'wk', 'project-name': 'Lot', status: 'In Progress', 'start-date': '2026-05-01', 'end-date': '2026-06-30', bidItems: [
        { id: 'w1', cost_code: '200', sub_code: 'S1', unit: 'TON', quantity: '1000', unit_cost: '80', start_date: '2026-05-04', target_date: '2026-05-29' },
        { id: 'w2', cost_code: '200', sub_code: 'S2', unit: 'TON', quantity: '300', unit_cost: '90', planned_rate: '300', start_date: day, target_date: day }],
      dailyRows: [row('2026-05-04', '200', 'S1', 100), row('2026-05-05', '200', 'S1', 100), row('2026-05-11', '200', 'S1', 100), row(day, '200', 'S2', 150)] }] });
      const wcols = allCols('plan_vs_actual');
      const wkOf = (day, basis) => {
        const def = vdef([vsec('plan_vs_actual', { columns: wcols }), vsec('chart', { columns: ['installed', 'plan'], options: { chart: 's_curve', basis } })],
          { dates: { preset: 'job_to_date', from: '', to: '' } });
        const ctx = vmk(def, WK(day), ['wk'], { today: '2026-05-12' });
        const d = V.buildSectionData(def.sections[0], def, ctx);
        const sc = J(V.buildSectionData(def.sections[1], def, ctx).blocks[0].charts[0]);
        return { rows: rowsOf(d).map(J), tot: J(d.blocks[0].totals), sc, at: sc.points.find(q => q.date === sc.asOf) || sc.points[sc.points.length - 1] };
      };
      const sat = wkOf('2026-05-09', 'pct'), fri = wkOf('2026-05-08', 'pct');
      const satQ = wkOf('2026-05-09', 'qty'), friQ = wkOf('2026-05-08', 'qty');
      const wl = byKey(sat.rows, 'sub_code', 'S2');
      assert('a Plan / Day line planned for one Saturday: the S-curve covers both items and ends on PvA Totals\' earned and scheduled %',
        sat.sc.drawPlan && !sat.sc.captions.some(c => /Covers the/.test(c)) && near(sat.at.inst, sat.tot.earned_pct) && near(sat.at.plan, sat.tot.sched_pct),
        JSON.stringify({ at: sat.at, tot: sat.tot, cap: sat.sc.captions }));
      assert('…on the quantity basis too, the same curve as with that line on the Friday',
        !satQ.sc.captions.some(c => /Covers the/.test(c)) && near(satQ.at.inst, friQ.at.inst) && near(satQ.at.plan, friQ.at.plan),
        JSON.stringify({ sat: satQ.at, fri: friQ.at, cap: satQ.sc.captions }));
      const wlFri = byKey(fri.rows, 'sub_code', 'S2');
      assert('…the Saturday line\'s own Days Ahead / Behind equals the same line on the Friday (not a day too good), and the Totals match',
        wl && wl.plan_source === 'Planned per day' && wl.ahead_days !== null && wlFri
          && wl.ahead_days === wlFri.ahead_days && JSON.stringify(sat.tot) === JSON.stringify(fri.tot),
        JSON.stringify({ wl, wlFri, sat: sat.tot, fri: fri.tot }));
    }

    // A Plan / Day or dated line whose whole span is non-working days (start =
    // target on a Saturday / Sunday / holiday) must read exactly as the same
    // line moved onto the previous working day, never a working day too good.
    // Each case below pairs the weekend/holiday line with its working-day twin
    // and asserts the customer-facing figures (ahead/behind, required / day,
    // forecast vs target, scheduled %, status, plan source) match.
    {
      const zCols = ['sub_code', 'installed_to_date', 'sched_pct', 'earned_pct', 'ahead_days', 'required_rate',
        'projected_finish', 'forecast_vs_target', 'start_date', 'target_date', 'plan_status', 'plan_source'];
      const zjob = (items, rows) => ({ projects: [{ id: 'z', 'project-name': 'Lot', status: 'In Progress', 'start-date': '2026-05-01', 'end-date': '',
        bidItems: items.map((it, i) => Object.assign({ id: 'z' + i, cost_code: '200', description: 'x', unit: 'TON', quantity: 300, unit_cost: 80 }, it)),
        dailyRows: rows.map((r, i) => Object.assign({ id: 'zr' + i, cost_code: '200', employee: 'Ann', labor_hours: 8 }, r)) }] });
      const zline = (items, rows, today, sub) => {
        const def = pva(zCols, { dates: { preset: 'job_to_date', from: '', to: '' } });
        const d = V.buildSectionData(def.sections[0], def, vmk(def, zjob(items, rows), ['z'], { today }));
        return { line: byKey(rowsOf(d), 'sub_code', sub || items[0].sub_code), tot: J(d.blocks[0].totals) };
      };
      // Rate line (Plan / Day) finished on its planned Saturday vs the Friday.
      const rDoneSat = zline([{ sub_code: 'E', planned_rate: 300, start_date: '2026-05-09', target_date: '2026-05-09' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 300 }], '2026-05-12');
      assert('a Plan / Day line finished on its planned Saturday reads 0 days ahead (was +1)', rDoneSat.line.ahead_days === 0, JSON.stringify(rDoneSat.line));
      // Finished the Monday after: one working day late.
      const rDoneMon = zline([{ sub_code: 'E', planned_rate: 300, start_date: '2026-05-09', target_date: '2026-05-09' }],
        [{ sub_code: 'E', date: '2026-05-09', quantity: 100 }, { sub_code: 'E', date: '2026-05-11', quantity: 200 }], '2026-05-12');
      assert('…finished the Monday after, −1', rDoneMon.line.ahead_days === -1, JSON.stringify(rDoneMon.line));
      // Half done on a Saturday target day: required / day is the whole
      // remainder over the one day (150), not blank, and status On track.
      const rHalfSat = zline([{ sub_code: 'E', planned_rate: 300, start_date: '2026-05-09', target_date: '2026-05-09' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 150 }], '2026-05-09');
      const rHalfFri = zline([{ sub_code: 'E', planned_rate: 300, start_date: '2026-05-08', target_date: '2026-05-08' }], [{ sub_code: 'E', date: '2026-05-08', quantity: 150 }], '2026-05-08');
      assert('…half done on its Saturday target day: Required / Day 150 (was blank), ahead −0.5, matching the Friday twin',
        rHalfSat.line.required_rate === 150 && rHalfSat.line.ahead_days === -0.5
          && rHalfSat.line.required_rate === rHalfFri.line.required_rate && rHalfSat.line.ahead_days === rHalfFri.line.ahead_days,
        JSON.stringify({ sat: rHalfSat.line, fri: rHalfFri.line }));
      // Unworked on its Saturday target day: line −1 and equal to its Totals.
      const rUnworkedSat = zline([{ sub_code: 'E', planned_rate: 300, start_date: '2026-05-09', target_date: '2026-05-09' }], [], '2026-05-09');
      assert('…unworked on its Saturday target day: line −1 (was 0) and equal to its Totals',
        rUnworkedSat.line.ahead_days === -1 && rUnworkedSat.tot.ahead_days === -1, JSON.stringify(rUnworkedSat));
      // Inverted: typed target Fri 5/8, first work Sat 5/9, finished Sat.
      const rInvSat = zline([{ sub_code: 'E', planned_rate: 300, target_date: '2026-05-08' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 300 }], '2026-05-12');
      const rInvThu = zline([{ sub_code: 'E', planned_rate: 300, target_date: '2026-05-07' }], [{ sub_code: 'E', date: '2026-05-08', quantity: 300 }], '2026-05-12');
      assert('…inverted (target before first work day): a Saturday first-work line reads 0, like its working-day twin (was +1)',
        rInvSat.line.ahead_days === 0 && rInvSat.line.ahead_days === rInvThu.line.ahead_days, JSON.stringify({ sat: rInvSat.line, thu: rInvThu.line }));

      // F6: Finish vs Target when the target is non-working. A dated LF line,
      // 200/day, today Thu 5/7, projected finish Mon 5/11.
      const fvtJob = (target, qty) => ({ projects: [{ id: 'f', 'project-name': 'Lot', status: 'In Progress', 'start-date': '2026-05-01', 'end-date': '',
        bidItems: [{ id: 'f1', cost_code: '300', sub_code: 'C', unit: 'LF', quantity: qty || 1000, unit_cost: 20, start_date: '2026-05-04', target_date: target }],
        dailyRows: [{ date: '2026-05-04', quantity: 200 }, { date: '2026-05-05', quantity: 200 }, { date: '2026-05-06', quantity: 200 }]
          .map((r, i) => Object.assign({ id: 'fr' + i, cost_code: '300', sub_code: 'C', employee: 'Ann', labor_hours: 8 }, r)) }] });
      const fvtOf = (target, qty, today) => {
        const def = pva(['sub_code', 'projected_finish', 'forecast_vs_target'], { dates: { preset: 'job_to_date', from: '', to: '' } });
        const d = V.buildSectionData(def.sections[0], def, vmk(def, fvtJob(target, qty), ['f'], { today: today || '2026-05-07' }, divCfg('turf')));
        return { line: rowsOf(d)[0], tot: J(d.blocks[0].totals) };
      };
      for (const [T, exp] of [['2026-05-08', -1], ['2026-05-09', -1], ['2026-05-10', -1], ['2026-05-11', 0]]) {
        const r = fvtOf(T);
        assert(`Finish vs Target: PF Mon 5/11 against target ${T} is ${exp} on the line and the Totals`,
          r.line.forecast_vs_target === exp && r.tot.forecast_vs_target === exp, JSON.stringify(r));
      }
      // Memorial Day (Mon 5/25) target and the Friday before it, PF Wed 5/27.
      const memJob = target => ({ projects: [{ id: 'm', 'project-name': 'Lot', status: 'In Progress', 'start-date': '2026-05-01', 'end-date': '',
        bidItems: [{ id: 'm1', cost_code: '300', sub_code: 'C', unit: 'LF', quantity: 1200, unit_cost: 20, start_date: '2026-05-18', target_date: target }],
        dailyRows: ['2026-05-18', '2026-05-19', '2026-05-20'].map((dt, i) => ({ id: 'mr' + i, cost_code: '300', sub_code: 'C', employee: 'Ann', labor_hours: 8, date: dt, quantity: 200 })) }] });
      for (const T of ['2026-05-22', '2026-05-25']) {
        const def = pva(['sub_code', 'projected_finish', 'forecast_vs_target'], { dates: { preset: 'job_to_date', from: '', to: '' } });
        const d = V.buildSectionData(def.sections[0], def, vmk(def, memJob(T), ['m'], { today: '2026-05-21' }, divCfg('turf')));
        const line = rowsOf(d)[0];
        assert(`Finish vs Target: PF Wed 5/27 against ${T === '2026-05-25' ? 'Memorial Day Mon 5/25' : 'Fri 5/22'} is −2`,
          line.projected_finish === '2026-05-27' && line.forecast_vs_target === -2, JSON.stringify(line));
      }

      // F8: a dated line (no Plan / Day) whose span is only non-working days
      // stays scheduled with its typed dates rather than "Not scheduled".
      const dSat = zline([{ sub_code: 'E', start_date: '2026-05-09', target_date: '2026-05-09' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 150 }], '2026-05-12');
      const dFri = zline([{ sub_code: 'E', start_date: '2026-05-08', target_date: '2026-05-08' }], [{ sub_code: 'E', date: '2026-05-08', quantity: 150 }], '2026-05-12');
      assert('a dated line whose Start = Target on a Saturday is scheduled (Bid item dates), not "Not scheduled", matching the Friday twin',
        dSat.line.plan_source === 'Bid item dates' && dSat.line.start_date === '2026-05-09' && dSat.line.target_date === '2026-05-09'
          && dSat.line.sched_pct === 100 && dSat.line.plan_status === 'Behind (past target)'
          && dSat.line.ahead_days === dFri.line.ahead_days, JSON.stringify({ sat: dSat.line, fri: dFri.line }));
      const dWknd = zline([{ sub_code: 'E', start_date: '2026-05-09', target_date: '2026-05-10' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 150 }], '2026-05-12');
      assert('…and a Sat→Sun dated closure is scheduled too', dWknd.line.plan_source === 'Bid item dates' && dWknd.line.plan_status === 'Behind (past target)', JSON.stringify(dWknd.line));

      // Round 5: Scheduled % of a span with no working day counts that day
      // too, as elapsed does — so on the Saturday of a Sat–Sun closure the
      // line, its Totals and the S-curve read as the Friday one-day twin.
      const sCols = zCols.concat(['spi', 'qty_variance']);
      const zs = (items, rows, today, dates) => {
        const def = pva(sCols, { dates: dates || { preset: 'job_to_date', from: '', to: '' } });
        def.sections.push(vsec('chart', { columns: ['installed', 'plan'], options: { chart: 's_curve', basis: 'pct', showPlan: true } }));
        const ctx = vmk(def, zjob(items, rows), ['z'], { today });
        const d = V.buildSectionData(def.sections[0], def, ctx), ch = J(V.buildSectionData(def.sections[1], def, ctx));
        const pts = ch.blocks[0].charts[0].points;
        return { line: J(rowsOf(d)[0]), tot: J(d.blocks[0].totals), at: day => pts.find(p => p.date === day) };
      };
      const cSat = zs([{ sub_code: 'E', start_date: '2026-05-09', target_date: '2026-05-10' }], [{ sub_code: 'E', date: '2026-05-09', quantity: 150 }], '2026-05-09');
      const cFri = zs([{ sub_code: 'E', start_date: '2026-05-08', target_date: '2026-05-08' }], [{ sub_code: 'E', date: '2026-05-08', quantity: 150 }], '2026-05-08');
      assert('a Sat–Sun closure on its Saturday: Scheduled 100%, pace 0.5, Qty vs Plan −150, −0.5 on the line and the Totals — the Friday twin (was 0% / +150 / Totals +0.5)',
        cSat.line.sched_pct === 100 && cSat.line.spi === 0.5 && cSat.line.qty_variance === -150 && cSat.line.ahead_days === -0.5
          && cSat.tot.ahead_days === cSat.line.ahead_days && cSat.tot.sched_pct === 100
          && ['sched_pct', 'spi', 'qty_variance', 'ahead_days', 'plan_status'].every(k => cSat.line[k] === cFri.line[k] && cSat.tot[k] === cFri.tot[k]),
        JSON.stringify({ sat: cSat, fri: cFri }));
      assert('…and the S-curve plans 100% on that Saturday, as on the Friday twin',
        cSat.at('2026-05-09') && cSat.at('2026-05-09').plan === 100 && cFri.at('2026-05-08').plan === 100, JSON.stringify(cSat.at('2026-05-09')));
      // Memorial Day weekend closure (Sat 5/23 – Mon 5/25), the Monday "Last week" send: as of Sun 5/24.
      const cMem = zs([{ sub_code: 'E', quantity: 600, start_date: '2026-05-23', target_date: '2026-05-25' }], [{ sub_code: 'E', date: '2026-05-23', quantity: 200 }],
        '2026-05-25', { preset: 'last_week', from: '', to: '' });
      assert('…and a Memorial Day weekend closure, sent the Monday as "Last week": Scheduled 100%, Qty vs Plan −400 (was 0% / +200)',
        cMem.line.sched_pct === 100 && cMem.line.qty_variance === -400 && cMem.tot.ahead_days === cMem.line.ahead_days, JSON.stringify(cMem));

      // Round 5: a past range is measured as of its end, so a line finished
      // after the range ended (but before its target) is not called late
      // when the report is run past that target.
      const lastWk = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'];
      const lw = (n, today) => zs([{ sub_code: 'B', quantity: 875, start_date: '2026-10-26', target_date: '2026-11-04' }],
        lastWk.slice(0, n).map(dt => ({ sub_code: 'B', date: dt, quantity: 125 })), today, { preset: 'last_week', from: '', to: '' });
      const lwOn = lw(7, '2026-11-03'), lwLate = lw(7, '2026-11-06');
      assert('"Last week" on a line finished Tue Nov 3 against target Wed Nov 4, run Fri Nov 6: On track +0.5 on the line and the Totals, as run on Nov 3 (was "Behind (past target)")',
        lwLate.line.plan_status === 'On track' && lwLate.tot.plan_status === 'On track' && lwLate.line.ahead_days === 0.5
          && ['sched_pct', 'spi', 'qty_variance', 'ahead_days', 'plan_status'].every(k => lwLate.line[k] === lwOn.line[k] && lwLate.tot[k] === lwOn.tot[k]),
        JSON.stringify({ late: lwLate, on: lwOn }));
      const lwStall = lw(6, '2026-11-06');
      assert('…while the twin still short of its quantity today (750 of 875) is "Behind (past target)", line and Totals',
        lwStall.line.plan_status === 'Behind (past target)' && lwStall.tot.plan_status === 'Behind (past target)', JSON.stringify(lwStall));
      const lwCustom = zs([{ sub_code: 'B', quantity: 875, start_date: '2026-10-26', target_date: '2026-11-04' }],
        lastWk.map(dt => ({ sub_code: 'B', date: dt, quantity: 125 })), '2026-11-06', { preset: 'custom', from: '2026-10-26', to: '2026-10-30' });
      assert('…and a custom past range (Oct 26–30) run Nov 6 is not "Behind (past target)" either',
        lwCustom.line.plan_status !== 'Behind (past target)' && lwCustom.tot.plan_status !== 'Behind (past target)', JSON.stringify(lwCustom));

      // Round 5: an unworked Plan / Day line with no Start, past its target
      // (typed, or the job's end date), is late — not "Not started".
      const rjob = (item, jobEnd) => ({ projects: [{ id: 'r', 'project-name': 'Lot', status: 'In Progress', 'start-date': '', 'end-date': jobEnd || '',
        bidItems: [Object.assign({ id: 'r1', cost_code: '300', sub_code: 'Seed', unit: 'SF', quantity: 1000, unit_cost: 1, planned_rate: 100 }, item)], dailyRows: [] }] });
      const rr5 = (item, jobEnd) => {
        const def = pva(zCols, { dates: { preset: 'job_to_date', from: '', to: '' } });
        const d = V.buildSectionData(def.sections[0], def, vmk(def, rjob(item, jobEnd), ['r'], { today: '2026-11-05' }));
        return { line: J(rowsOf(d)[0]), tot: J(d.blocks[0].totals) };
      };
      const rTyped = rr5({ target_date: '2026-10-01' }), rEnd = rr5({}, '2026-10-01'), rFuture = rr5({}, '2026-12-31');
      assert('an unworked Plan / Day line with no Start and a typed Target Oct 1, run Nov 5: "Behind (past target)", line and Totals (was "Not started" / "Not scheduled")',
        rTyped.line.plan_status === 'Behind (past target)' && rTyped.tot.plan_status === 'Behind (past target)', JSON.stringify(rTyped));
      assert('…and with no dates but a job end date of Oct 1: "Behind (past target)" with no days figure (was 0 beside "Not started")',
        rEnd.line.plan_status === 'Behind (past target)' && rEnd.line.ahead_days === null && rEnd.tot.plan_status === 'Behind (past target)', JSON.stringify(rEnd));
      assert('…while one whose job ends Dec 31 is still "Not started", with no days figure either',
        rFuture.line.plan_status === 'Not started' && rFuture.line.ahead_days === null, JSON.stringify(rFuture));

      // Round 6: "done today" spares only a line finished by its target. One
      // still open at the range's end with its target already behind that
      // end was late as of the report, so finishing it since does not clear
      // "Behind (past target)" on the line or its Totals.
      const PT = 'Behind (past target)';
      const lwOver = zs([{ sub_code: 'B', quantity: 100, start_date: '2026-10-26', target_date: '2026-11-04' }],
        [{ sub_code: 'B', date: '2026-10-28', quantity: 45 }, { sub_code: 'B', date: '2026-11-06', quantity: 45 }, { sub_code: 'B', date: '2026-11-09', quantity: 10 }],
        '2026-11-10', { preset: 'last_week', from: '', to: '' });
      assert('"Last week" sent Tue Nov 10 on a line due Nov 4, 90% in by Sun Nov 8 and finished Mon Nov 9: "Behind (past target)", line and Totals, no Needed / Day (was "At risk" / "On track")',
        lwOver.line.plan_status === PT && lwOver.tot.plan_status === PT && lwOver.line.required_rate === null, JSON.stringify(lwOver));
      const pastOver = zs([{ sub_code: 'B', quantity: 100, start_date: '2026-10-05', target_date: '2026-10-05' }],
        [{ sub_code: 'B', date: '2026-10-19', quantity: 100 }], '2026-11-06', { preset: 'custom', from: '2026-10-01', to: '2026-10-16' });
      assert('…and a custom Oct 1–16 range on a line due Oct 5 with none in by Oct 16 (all in Oct 19), run Nov 6: "Behind (past target)", line and Totals (was Totals "On track" at 0% earned of 100%)',
        pastOver.line.plan_status === PT && pastOver.tot.plan_status === PT, JSON.stringify(pastOver));
      assert('…while the line finished Nov 3 against target Nov 4 (open at Nov 1) still reads "On track"',
        lwLate.line.plan_status === 'On track' && lwLate.tot.plan_status === 'On track', JSON.stringify(lwLate));

      // Round 6: a line finished by its target after a past range ended, run
      // past that target, has no Needed / Day — as its Totals — rather than 0.
      const xItem = [{ sub_code: 'B', quantity: 100, start_date: '2026-10-12', target_date: '2026-10-20' }];
      const xRows = [{ sub_code: 'B', date: '2026-10-14', quantity: 40 }, { sub_code: 'B', date: '2026-10-19', quantity: 60 }];
      const xRange = { preset: 'custom', from: '2026-10-01', to: '2026-10-16' };
      const xLate = zs(xItem, xRows, '2026-11-06', xRange), xOn = zs(xItem, xRows, '2026-10-19', xRange);
      assert('a custom Oct 1–16 range on a line due Oct 20 finished Oct 19, run Nov 6: Needed / Day blank on the line and the Totals (was 0 beside blank)',
        xLate.line.required_rate === null && xLate.tot.required_rate === null, JSON.stringify(xLate));
      assert('…and run Oct 19, with its target still ahead, 0 on both',
        xOn.line.required_rate === 0 && xOn.tot.required_rate === 0, JSON.stringify(xOn));

      // Round 6: an unworked Plan / Day line with no start, past its target,
      // makes the Totals late even beside a finished measurable line whose
      // own (earlier) target is the Totals' — and in a combined report's
      // subtotal and grand total, and with completed lines hidden.
      const c2Items = [{ sub_code: 'Surface', quantity: 500, planned_rate: 100, target_date: '2026-10-09' },
        { sub_code: 'Base', quantity: 300, start_date: '2026-09-14', target_date: '2026-09-25' }];
      const c2Rows = [{ sub_code: 'Base', date: '2026-09-15', quantity: 150 }, { sub_code: 'Base', date: '2026-09-22', quantity: 150 }];
      const c2 = (items, rows, today, defPatch, sec) => {
        const def = pva(zCols, Object.assign({ dates: { preset: 'job_to_date', from: '', to: '' } }, defPatch || {}), sec);
        const b = J(V.buildSectionData(def.sections[0], def, vmk(def, zjob(items, rows), ['z'], { today })).blocks[0]);
        return { lines: b.groups.flatMap(g => g.rows.map(r => r.cells)), subs: b.groups.map(g => g.subtotal).filter(Boolean), tot: b.totals };
      };
      const c2Sep = c2(c2Items, c2Rows, '2026-11-06'), c2Comb = c2(c2Items, c2Rows, '2026-11-06', { layout: 'combined' });
      const c2Hide = c2(c2Items, c2Rows, '2026-11-06', null, { options: { hideComplete: true } });
      assert('Surface (Plan / Day, no start, unworked, due Oct 9) beside a finished Base (due Sep 25), run Nov 6: Totals "Behind (past target)" (was "On track")',
        c2Sep.lines.find(l => l.sub_code === 'Surface').plan_status === PT && c2Sep.tot.plan_status === PT, JSON.stringify(c2Sep));
      assert('…and the combined layout\'s job subtotal and grand total read the same',
        c2Comb.subs.length === 1 && c2Comb.subs[0].plan_status === PT && c2Comb.tot.plan_status === PT, JSON.stringify(c2Comb));
      assert('…as do the Totals with completed lines hidden', c2Hide.tot.plan_status === PT, JSON.stringify(c2Hide));
      const c3 = c2([c2Items[0], { sub_code: 'Base', quantity: 300, start_date: '2026-10-26', target_date: '2026-11-20' }],
        [{ sub_code: 'Base', date: '2026-10-27', quantity: 100 }, { sub_code: 'Base', date: '2026-11-03', quantity: 100 }], '2026-11-06');
      assert('…while beside an open Base on track with the Totals\' target (Nov 20) still ahead, the Totals are not "Behind (past target)"',
        c3.tot.plan_status !== PT && c3.tot.target_date === '2026-11-20', JSON.stringify(c3));

      // Round 6: one open line in its span and its Totals compute the same
      // days ahead two ways (EP·W − E, and (EP − SP)·W); float noise in the
      // second must not round it to a different half day.
      const hd = zline([{ sub_code: 'H', quantity: 40, start_date: '2025-06-26', target_date: '2025-07-21' }],
        [{ sub_code: 'H', date: '2025-06-26', quantity: 15 }, { sub_code: 'H', date: '2025-07-01', quantity: 15 }], '2025-07-20');
      assert('a line Jun 26–Jul 21 2025 (17 working days), 30 of 40 in, run Jul 20: −3 days, "At risk", on the line and the Totals (Totals were −3.5 "Behind")',
        hd.line.ahead_days === -3 && hd.tot.ahead_days === -3 && hd.line.plan_status === 'At risk' && hd.tot.plan_status === 'At risk', JSON.stringify(hd));
      const hdMiss = [];
      const addD = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
      for (const S of ['2025-06-02', '2025-06-26', '2026-03-04']) {
        for (const span of [6, 13, 24, 37]) {
          const T = addD(S, span);
          for (let a = 1; a < span; a += 2) {
            const A = addD(S, a);
            for (const f of [0.25, 0.5, 0.75]) {
              const r = zline([{ sub_code: 'H', quantity: 40, start_date: S, target_date: T }], [{ sub_code: 'H', date: S, quantity: 40 * f }], A);
              if (r.line.ahead_days !== r.tot.ahead_days || r.line.plan_status !== r.tot.plan_status) hdMiss.push({ S, T, A, f, line: r.line.ahead_days, tot: r.tot.ahead_days });
            }
          }
        }
      }
      assert('…and over single open lines (several spans and days, 25 / 50 / 75% in) the line and its Totals always read the same days and status',
        hdMiss.length === 0, JSON.stringify(hdMiss.slice(0, 5)) + ` (${hdMiss.length})`);

      // Round 5: a dated line with no quantity (zeroed by a change order, or
      // not entered yet) has nothing to measure: "Not scheduled", like its
      // Totals, with no Scheduled % — never a blank status.
      const qz = (item, sec) => {
        const def = pva(sCols, { dates: { preset: 'job_to_date', from: '', to: '' } }, sec);
        const data = { projects: [{ id: 'q', 'project-name': 'Lot', status: 'In Progress', 'start-date': '', 'end-date': '',
          bidItems: [Object.assign({ id: 'q1', cost_code: '400', sub_code: 'Edge', unit: 'LF', unit_cost: 5, start_date: '2026-11-02', target_date: '2026-11-20' }, item)],
          dailyRows: item.rows || [] }] };
        const d = V.buildSectionData(def.sections[0], def, vmk(def, data, ['q'], { today: '2026-11-05' }));
        return { line: J(rowsOf(d)[0] || null), tot: J(d.blocks[0].totals), notes: J(d.blocks[0].notes || d.notes || null) };
      };
      const qCo = qz({ quantity: 400, change_orders: [{ qty_delta: -400 }], rows: [row('2026-11-02', '400', 'Edge', 50)] });
      const qBlank = qz({ quantity: '' });
      assert('a dated LF line zeroed by a change order: "Not scheduled" with no Scheduled %, as its Totals (was a blank status beside 28.57%)',
        qCo.line.plan_status === 'Not scheduled' && qCo.line.sched_pct === null && qCo.line.qty_variance === null && qCo.tot.plan_status === 'Not scheduled', JSON.stringify(qCo));
      assert('…and one whose quantity is blank reads the same', qBlank.line.plan_status === 'Not scheduled' && qBlank.line.sched_pct === null, JSON.stringify(qBlank));
      assert('…counted in the footnote as having no plan, and hidden by "Hide items with no plan" like any "Not scheduled" line',
        /1 of 1 item has no plan/.test(JSON.stringify(qCo.notes)) && qz({ quantity: '' }, { options: { hideUnplanned: true } }).line === null, JSON.stringify(qCo.notes));
      const qLs = qz({ unit: 'LS', quantity: 1, rows: [row('2026-11-02', '400', 'Edge', 0)] });
      assert('…while an LS line of 1 keeps its Scheduled % and status', qLs.line.sched_pct !== null && !!qLs.line.plan_status && qLs.line.plan_status !== 'Not scheduled', JSON.stringify(qLs));
    }

    // Round 5: a combined report's grand total over jobs whose plans span
    // different months takes each job's own roll-up and weighs them by bid
    // dollars — never the cross-job % gap times the working days from the
    // first job's start to the last job's target.
    {
      const cjob = (id, s, t, days, q) => ({ id, 'project-name': 'Job ' + id, status: 'In Progress', 'start-date': '', 'end-date': '',
        bidItems: [{ id: id + '1', cost_code: '500', sub_code: 'Sod', unit: 'SF', quantity: '1000', unit_cost: '10', start_date: s, target_date: t }],
        dailyRows: days.map(dt => row(dt, '500', 'Sod', q)) });
      const marDays = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];
      const octDays = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
      const jA = cjob('A', '2026-03-02', '2026-03-27', marDays, 100), jB = cjob('B', '2026-10-01', '2026-11-30', octDays, 50);
      const cols = ['sub_code', 'sched_pct', 'earned_pct', 'ahead_days', 'plan_status'];
      const totFor = (projects, layout) => {
        const def = vdef([vsec('plan_vs_actual', { columns: cols })], { layout, dates: { preset: 'job_to_date', from: '', to: '' } });
        return J(V.buildSectionData(def.sections[0], def, vmk(def, { projects }, projects.map(p => p.id))).blocks[0].totals);
      };
      const tA = totFor([jA], 'separate'), tB = totFor([jB], 'separate'), tAB = totFor([jA, jB], 'combined');
      const exp = Math.round(((tA.ahead_days || 0) + (-11.27)) / 2 * 2) / 2;
      assert('combined grand total over a job done in March and one behind in Oct–Nov: days ahead no bigger than either job\'s own, the bid-weighted mean (was −26)',
        Math.abs(tAB.ahead_days) <= Math.max(Math.abs(tA.ahead_days), Math.abs(tB.ahead_days)) && tAB.ahead_days === exp && tAB.ahead_days === -5.5,
        JSON.stringify({ tA, tB, tAB }));
      const jD = Object.assign(cjob('D', '2026-10-01', '2026-11-30', octDays, 50));
      const tBD = totFor([jB, jD], 'combined');
      assert('…while two jobs on the same span total what each reads (−11)', tBD.ahead_days === -11 && tB.ahead_days === -11, JSON.stringify({ tB, tBD }));
    }

    // Round 7: Planned vs Actual over past ranges and mixed bases — the
    // Totals read their own target by the line rule, a Plan / Day line's
    // start is a day worked by the report's end, a line and its Totals agree
    // on "Behind (past target)" vs "Not started", and a combined grand total
    // counts every measured job, planned or on its job dates.
    {
      const PT = 'Behind (past target)';
      const r7cols = ['sub_code', 'sched_pct', 'earned_pct', 'ahead_days', 'start_date', 'target_date', 'plan_status', 'plan_source'];
      const r7row = (date, sc, q, cc) => row(date, cc || '200', sc, q);
      const r7 = (projects, dates, today, layout) => {
        const def = vdef([vsec('plan_vs_actual', { columns: r7cols })], { layout: layout || 'separate', dates });
        const b = J(V.buildSectionData(def.sections[0], def, vmk(def, { projects }, projects.map(p => p.id), { today })).blocks[0]);
        return { lines: b.groups.flatMap(g => g.rows.map(r => r.cells)), subs: b.groups.map(g => g.subtotal).filter(Boolean), tot: b.totals };
      };
      const line = (res, sc) => res.lines.find(l => l.sub_code === sc) || {};

      // (1a) Planned lines: a custom Oct 1–16 range, every line finished since
      // by the Totals' target (Oct 30). Curb was due Oct 9 and finished Oct 19
      // (late as of the range's end); Surface due Oct 30, finished Oct 28.
      const oct1to16 = { preset: 'custom', from: '2026-10-01', to: '2026-10-16' };
      const f1a = extra => [{ id: 'r7a', 'project-name': 'Main', status: 'In Progress', 'start-date': '', 'end-date': '', bidItems: [
        { id: 'r7a1', cost_code: '200', sub_code: 'Curb', unit: 'TON', quantity: 10, unit_cost: 10, start_date: '2026-10-05', target_date: '2026-10-09' },
        { id: 'r7a2', cost_code: '200', sub_code: 'Surface', unit: 'TON', quantity: 200, unit_cost: 80, start_date: '2026-10-13', target_date: '2026-10-30' }],
      dailyRows: [r7row('2026-10-07', 'Curb', 4), r7row('2026-10-19', 'Curb', 6), r7row('2026-10-13', 'Surface', 50), r7row('2026-10-14', 'Surface', 50),
        r7row('2026-10-15', 'Surface', 50)].concat(extra) }];
      const aLast = [r7row('2026-10-28', 'Surface', 50)];
      const aOct29 = r7(f1a(aLast), oct1to16, '2026-10-29'), aNov6 = r7(f1a(aLast), oct1to16, '2026-11-06');
      const aComb = r7(f1a(aLast), oct1to16, '2026-11-06', 'combined'), aOpen = r7(f1a([]), oct1to16, '2026-11-06');
      assert('round 7: a custom Oct 1–16 report, every line finished since by the Totals\' target (Oct 30), run Nov 6: Totals "On track" +8.5, as run Oct 29 (was "Behind (past target)"); Curb still "Behind (past target)"',
        aOct29.tot.plan_status === 'On track' && aOct29.tot.ahead_days === 8.5 && aNov6.tot.plan_status === 'On track' && aNov6.tot.ahead_days === 8.5
          && line(aOct29, 'Curb').plan_status === PT && line(aNov6, 'Curb').plan_status === PT, JSON.stringify({ aOct29, aNov6 }));
      assert('…and the combined layout\'s job subtotal and grand total read the same',
        aComb.subs.length === 1 && aComb.subs[0].plan_status === 'On track' && aComb.tot.plan_status === 'On track' && aComb.tot.ahead_days === 8.5, JSON.stringify(aComb));
      assert('…while with Surface still open today (no Oct 28 row) the Totals are "Behind (past target)"',
        aOpen.tot.plan_status === PT, JSON.stringify(aOpen));

      // (1b) Job dates: Sep 1 – Oct 30, one SF line, finished Oct 28; a
      // "September" report run Oct 15 and again Nov 6.
      const f1b = (end, rows) => [{ id: 'r7b', 'project-name': 'Lawn', status: 'In Progress', 'start-date': '2026-09-01', 'end-date': end, bidItems: [
        { id: 'r7b1', cost_code: '200', sub_code: 'Sod', unit: 'SF', quantity: 1000, unit_cost: 2 }], dailyRows: rows }];
      const bRows = [r7row('2026-09-08', 'Sod', 300), r7row('2026-09-22', 'Sod', 300)], bLast = r7row('2026-10-28', 'Sod', 400);
      const sept = { preset: 'custom', from: '2026-09-01', to: '2026-09-30' };
      const bOct15 = r7(f1b('2026-10-30', bRows.concat([bLast])), sept, '2026-10-15'), bNov6 = r7(f1b('2026-10-30', bRows.concat([bLast])), sept, '2026-11-06');
      const bComb = r7(f1b('2026-10-30', bRows.concat([bLast])), sept, '2026-11-06', 'combined');
      const bOpen = r7(f1b('2026-10-30', bRows), sept, '2026-11-06'), bEarly = r7(f1b('2026-09-25', bRows.concat([bLast])), sept, '2026-11-06');
      assert('round 7: a job on its job dates (Sep 1 – Oct 30) finished Oct 28, its "September" report run Nov 6: Totals "On track" +4 on Job dates, as run Oct 15 (was "Behind (past target)")',
        [bOct15, bNov6, bComb].every(x => x.tot.plan_status === 'On track' && x.tot.ahead_days === 4 && x.tot.plan_source === 'Job dates'), JSON.stringify({ bOct15, bNov6, bComb }));
      assert('…while with the job still open today, or a job end (Sep 25) before the range\'s end, it is "Behind (past target)"',
        bOpen.tot.plan_status === PT && bEarly.tot.plan_status === PT, JSON.stringify({ bOpen: bOpen.tot, bEarly: bEarly.tot }));

      // (2) A Plan / Day line with no typed Start takes its start from a day
      // worked by the report's end — never one worked after a past range.
      const f2 = extra => [{ id: 'r7c', 'project-name': 'Main', status: 'In Progress', 'start-date': '', 'end-date': '', bidItems: [
        { id: 'r7c1', cost_code: '200', sub_code: 'Seal', unit: 'SY', quantity: 500, unit_cost: 5, planned_rate: 100, target_date: '2026-10-09' },
        { id: 'r7c2', cost_code: '200', sub_code: 'Base', unit: 'SY', quantity: 300, unit_cost: 5, start_date: '2026-10-05', target_date: '2026-10-30' }],
      dailyRows: [r7row('2026-10-06', 'Base', 150), r7row('2026-10-20', 'Base', 150)].concat(extra) }];
      const octM = { preset: 'custom', from: '2026-10-01', to: '2026-10-31' }, sealNov = [r7row('2026-11-03', 'Seal', 200)];
      const sOct31 = r7(f2([]), octM, '2026-10-31'), sNov6 = r7(f2(sealNov), octM, '2026-11-06');
      const sJtd = r7(f2(sealNov), { preset: 'job_to_date', from: '', to: '' }, '2026-11-06');
      assert('round 7: an October report on a Plan / Day line (no Start, due Oct 9, nothing in by Oct 31), run Nov 6 after 200 SY went in Nov 3: "Behind (past target)" with no days or start, Totals 100 / 100 — as run Oct 31 (was "Not started", start Nov 3, Totals 37.5 / 37.5)',
        [sOct31, sNov6].every(x => line(x, 'Seal').plan_status === PT && line(x, 'Seal').ahead_days === null && line(x, 'Seal').start_date === null
          && x.tot.sched_pct === 100 && x.tot.earned_pct === 100), JSON.stringify({ sOct31, sNov6 }));
      assert('…while job to date it still starts Nov 3, −3.5 days',
        line(sJtd, 'Seal').start_date === '2026-11-03' && line(sJtd, 'Seal').ahead_days === -3.5, JSON.stringify(sJtd));

      // (3) A line whose whole plan falls between a past range's end and
      // today, unfinished today: late on the line and its Totals alike.
      const f3 = [{ id: 'r7d', 'project-name': 'Main', status: 'In Progress', 'start-date': '', 'end-date': '', bidItems: [
        { id: 'r7d1', cost_code: '200', sub_code: 'Base', unit: 'TON', quantity: 300, unit_cost: 40, start_date: '2026-10-05', target_date: '2026-10-23' },
        { id: 'r7d2', cost_code: '200', sub_code: 'Surface', unit: 'TON', quantity: 200, unit_cost: 80, start_date: '2026-11-02', target_date: '2026-11-04' }],
      dailyRows: [r7row('2026-10-06', 'Base', 100), r7row('2026-10-13', 'Base', 100), r7row('2026-10-20', 'Base', 100), r7row('2026-11-03', 'Surface', 100)] }];
      const lastM = { preset: 'last_month', from: '', to: '' };
      const nLm = r7(f3, lastM, '2026-11-06'), nComb = r7(f3, lastM, '2026-11-06', 'combined'), nOct31 = r7(f3, octM, '2026-10-31');
      assert('round 7: "Last month" run Nov 6, Surface planned Nov 2–4 and half in: the line, its Totals, the combined subtotal and grand total all read "Behind (past target)" (the line read "Not started")',
        line(nLm, 'Surface').plan_status === PT && nLm.tot.plan_status === PT && nComb.subs.length === 1 && nComb.subs[0].plan_status === PT
          && nComb.tot.plan_status === PT && line(nComb, 'Surface').plan_status === PT, JSON.stringify({ nLm, nComb }));
      assert('…while an Oct 1–31 report run Oct 31 still reads Surface "Not started", Totals "On track"',
        line(nOct31, 'Surface').plan_status === 'Not started' && nOct31.tot.plan_status === 'On track', JSON.stringify(nOct31));

      // (4) A combined grand total counts every measured job: one measured on
      // its job dates is rolled up on them, beside the others.
      const jdJob = (id, s, e, rows) => ({ id, 'project-name': 'Job ' + id, status: 'In Progress', 'start-date': s, 'end-date': e, bidItems: [
        { id: id + '1', cost_code: '500', sub_code: 'Sod', unit: 'SF', quantity: 1000, unit_cost: 2 },
        { id: id + '2', cost_code: '500', sub_code: 'Seed', unit: 'SF', quantity: 1000, unit_cost: 1 }], dailyRows: rows });
      const bdJob = id => ({ id, 'project-name': 'Job ' + id, status: 'In Progress', 'start-date': '', 'end-date': '', bidItems: [
        { id: id + '1', cost_code: '500', sub_code: 'Sod', unit: 'SF', quantity: 1000, unit_cost: 2, start_date: '2026-10-19', target_date: '2026-11-27' },
        { id: id + '2', cost_code: '500', sub_code: 'Seed', unit: 'SF', quantity: 1000, unit_cost: 1, start_date: '2026-10-19', target_date: '2026-11-27' }],
      dailyRows: [r7row('2026-10-20', 'Sod', 800, '500'), r7row('2026-10-21', 'Seed', 800, '500')] });
      const gA = jdJob('GA', '2026-09-01', '2026-10-30', [r7row('2026-09-10', 'Sod', 100, '500')]);
      const gB = jdJob('GB', '2026-09-14', '2026-10-23', [r7row('2026-09-20', 'Seed', 50, '500')]);
      const gC = bdJob('GC');
      const jtd = { preset: 'job_to_date', from: '', to: '' };
      const gAB = r7([gA, gB], jtd, '2026-11-05', 'combined'), gAC = r7([gA, gC], jtd, '2026-11-05', 'combined');
      // A: 42 working days, 100% scheduled, 6.67% earned → −39.2; B: 29 days, 1.67% → −28.5; equal bid dollars → −33.9 → −34.
      assert('round 7: a combined grand total over two jobs on their job dates (−39 and −28.5, past their ends): their bid-weighted mean, −34, "Behind (past target)" on Job dates (was "Not scheduled", blank)',
        gAB.subs.map(s => s.ahead_days).join('|') === '-39|-28.5' && gAB.tot.ahead_days === -34 && gAB.tot.plan_status === PT
          && gAB.tot.sched_pct === 100 && near(gAB.tot.earned_pct, (20 / 3 + 5 / 3) / 2) && gAB.tot.plan_source === 'Job dates'
          && gAB.tot.start_date === '2026-09-01' && gAB.tot.target_date === '2026-10-30', JSON.stringify(gAB));
      // A −39.2 and C +8.4 (50% scheduled, 80% earned over 28 days), equal bid dollars → −15.4 → −15.5.
      assert('…and over a job on its job dates (−39) beside a bid-dated one (+8.5): −15.5 "Behind", Scheduled 75%, no single basis (was C alone: "On track" +8.5)',
        gAC.subs.map(s => s.ahead_days).join('|') === '-39|8.5' && gAC.tot.ahead_days === -15.5 && gAC.tot.plan_status === 'Behind'
          && near(gAC.tot.sched_pct, 75) && near(gAC.tot.earned_pct, (20 / 3 + 80) / 2) && gAC.tot.plan_source === null
          && gAC.tot.target_date === '2026-11-27', JSON.stringify(gAC));
    }

    // A cost-code-only line (TON) beside a sub-coded line under its code
    // typed TN: the two share the sub-coded rows. TN and TON are one unit in
    // Planned vs Actual, so its Totals' Installed to Date is one figure —
    // as with the lines typed alike — while Bid Progress, which pairs each
    // typed unit's Bid Qty with its Installed, keeps them apart.
    {
      const SH = { projects: [{ id: 'sh', 'project-name': 'Lot A', status: 'In Progress', 'start-date': '2026-05-01', 'end-date': '2026-06-30', bidItems: [
        { id: 's1', cost_code: '200', sub_code: '', unit: 'TON', quantity: '1000', unit_cost: '60', start_date: '2026-05-04', target_date: '2026-05-29' },
        { id: 's2', cost_code: '200', sub_code: 'S1', unit: 'TN', quantity: '500', unit_cost: '80', start_date: '2026-05-04', target_date: '2026-05-29' }],
      dailyRows: [row('2026-05-04', '200', '', 200), row('2026-05-05', '200', 'S1', 150), row('2026-05-06', '200', '', 220), row('2026-05-07', '200', 'S1', 130)] }] };
      const shCols = ['sub_code', 'unit', 'bid_qty', 'installed_to_date', 'actual_rate'];
      const shDef = layout => vdef([vsec('plan_vs_actual', { columns: shCols }), vsec('bid_progress', { columns: ['sub_code', 'unit', 'bid_qty', 'installed_to_date'] })],
        { layout, dates: { preset: 'job_to_date', from: '', to: '' } });
      const sd = shDef('separate'), sctx = vmk(sd, SH, ['sh'], { today: '2026-05-08' });
      const st = J(V.buildSectionData(sd.sections[0], sd, sctx).blocks[0].totals);
      assert('shared rows, a TON line and a TN line: PvA Totals\' Installed to Date is 700 (one number, not "420 TON · 280 TN"), Bid Qty 1,500, Actual / Day 175',
        st.installed_to_date === 700 && st.bid_qty === 1500 && st.actual_rate === 175 && st.unit === 'TON', JSON.stringify(st));
      const cd = shDef('combined'), cctx = vmk(cd, SH, ['sh'], { today: '2026-05-08' });
      const cb = J(V.buildSectionData(cd.sections[0], cd, cctx).blocks[0]);
      const sub = cb.groups.map(g => g.subtotal).filter(Boolean)[0];
      assert('…and the combined layout\'s job subtotal and grand total read 700 too',
        sub && sub.installed_to_date === 700 && cb.totals.installed_to_date === 700, JSON.stringify({ sub, tot: cb.totals }));
      const wb = workbook(V.buildXlsx(sd, vmk(sd, SH, ['sh'], { today: '2026-05-08' })));
      const rep = wb.sheets[wb.names.find(n => /plan/i.test(n))] || {}, ih = findCell(rep, 'Installed to Date');
      const totRow = ih && Object.keys(rep).filter(r => rep[r].v === 'Totals').map(r => +r.replace(/\D+/g, '')).find(n => n > ih.row);
      const xc = totRow && rep[ih.col + totRow];
      assert('…and the XLSX Totals cell is the number 700', xc && xc.t !== 'inlineStr' && xc.v === 700, JSON.stringify({ ih, totRow, xc }));
      const bt = J(V.buildSectionData(sd.sections[1], sd, sctx).blocks[0].totals);
      assert('…while Bid Progress\' Totals still pair Bid Qty and Installed by the units as typed',
        bt.bid_qty === '1,000 TON · 500 TN' && bt.installed_to_date === '420 TON · 280 TN', JSON.stringify(bt));

      // Production Rates Totals over the same shared rows: the cost-code-only
      // line and the sub-coded line take the same rows, so the quantity, best
      // day, labour hours and per-day rate must count them once — not the 980
      // / 245 / 300 / 48 doubling — and agree with PvA Actual / Day and Rate
      // Summary tons/day in the same report.
      const pkSecs = vdef([
        vsec('production_kpis', { columns: ['sub_code', 'unit', 'qty_period', 'days_period', 'avg_per_day', 'best_day', 'remaining_qty', 'labor_hours', 'units_per_mh'], options: { totals: true } }),
        vsec('plan_vs_actual', { columns: ['sub_code', 'actual_rate'], options: { totals: true } }),
        vsec('rate_summary', { columns: allCols('rate_summary') })],
        { includeInternal: true, dates: { preset: 'job_to_date', from: '', to: '' } });
      const pkCtx = vmk(pkSecs, SH, ['sh'], { today: '2026-05-08' });
      const pkTot = J(V.buildSectionData(pkSecs.sections[0], pkSecs, pkCtx).blocks[0].totals);
      const pvTot = J(V.buildSectionData(pkSecs.sections[1], pkSecs, pkCtx).blocks[0].totals);
      const rsRow = J(V.buildSectionData(pkSecs.sections[2], pkSecs, pkCtx).blocks[0].groups[0].rows[0].cells);
      assert('Production Rates Totals count shared rows once: Qty 700, Avg / Day 175, Best Day 220, Days 4, Remaining blank (was 980 / 245 / 300)',
        pkTot.qty_period === 700 && pkTot.avg_per_day === 175 && pkTot.best_day === 220 && pkTot.days_period === 4 && pkTot.remaining_qty === null,
        JSON.stringify(pkTot));
      assert('…Labour Hours 32 and Units / MH 21.875 (one base), and Avg / Day ties to PvA Actual / Day and Rate Summary tons/day',
        pkTot.labor_hours === 32 && near(pkTot.units_per_mh, 21.875) && pkTot.avg_per_day === pvTot.actual_rate && pkTot.avg_per_day === rsRow.tons_per_day,
        JSON.stringify({ pkTot, actual_rate: pvTot.actual_rate, tons_per_day: rsRow.tons_per_day }));
    }

    // A Plan / Day line whose finish cannot be dated (no Target, no job end
    // date, and a rate — mistyped — implying more than the calendar holds),
    // never worked, five months after its start: no pace to read, so not
    // "0 days, On track"; it and its Totals agree.
    {
      const UND = { projects: [{ id: 'und', 'project-name': 'Big Turf', status: 'In Progress', 'end-date': '', bidItems: [
        { id: 'u1', cost_code: 'Turf', sub_code: 'Sod', unit: 'SF', quantity: '250000', unit_cost: '1', planned_rate: '50', start_date: '2026-06-01' }],
      dailyRows: [] }] };
      const ucols = ['sub_code', 'planned_rate', 'ahead_days', 'target_date', 'plan_status'];
      const ud = V.buildSectionData(pva(ucols).sections[0], pva(ucols), vmk(pva(ucols), UND, ['und'], { today: '2026-11-06' }, divCfg('turf')));
      const ul = J(rowsOf(ud)[0]), ut = J(ud.blocks[0].totals);
      assert('an unstarted Plan / Day line with no datable finish, months past its start: not "On track, 0 days", and it reads as its Totals do',
        ul.plan_status !== 'On track' && ul.plan_status === ut.plan_status && ul.ahead_days === ut.ahead_days, JSON.stringify({ ul, ut }));
    }

    // A planned line beside an unplanned one in the same unit: every plan
    // comparison in Totals is the planned line's.
    const F2 = { projects: [{ id: 'f2', 'project-name': 'A', status: 'In Progress', bidItems: [
      { id: 'x1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-20' },
      { id: 'x2', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '20000', unit_cost: '10' }],
    dailyRows: [row('2026-11-02', 'Pave', 'Base', 50), row('2026-11-03', 'Pave', 'Base', 50), row('2026-11-04', 'Pave', 'Base', 50),
      row('2026-11-02', 'Pave', 'Top', 2000), row('2026-11-03', 'Pave', 'Top', 2000), row('2026-11-04', 'Pave', 'Top', 2000)] }] };
    const c2 = V.newSection('plan_vs_actual').columns.concat(['actual_rate_jtd', 'required_rate', 'projected_finish', 'forecast_vs_target']);
    const t2 = totOf(pva(c2), F2, ['f2']);
    assert('an unplanned line\'s work is not the plan\'s: Actual / Day 50 beside Planned 71.43 and 70% (was 2,050 beside 70%)',
      t2.actual_rate === 50 && t2.actual_rate_jtd === 50 && near(t2.planned_rate, 1000 / 14) && near(t2.pct_of_plan, 70), JSON.stringify(t2));
    assert('…needed / day is the planned line\'s 850 over 11 days (77.27), and its finish Dec 2 is 7 days past the target',
      near(t2.required_rate, 850 / 11) && t2.projected_finish === '2026-12-02' && t2.forecast_vs_target === -7
        && t2.bid_qty === 21000 && t2.installed_to_date === 6150, JSON.stringify(t2));
    const S13 = { projects: [{ id: 's13', 'project-name': 'A', status: 'In Progress', bidItems: [
      { id: 'x1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-20' },
      { id: 'x2', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '5000', unit_cost: '10' }],
    dailyRows: [row('2026-11-02', 'Pave', 'Base', 300), row('2026-11-03', 'Pave', 'Base', 300), row('2026-11-04', 'Pave', 'Base', 300), row('2026-11-04', 'Pave', 'Top', 50)] }] };
    const t13 = totOf(pva(c2), S13, ['s13']);
    assert('…and a planned line on pace beside a slow unplanned one: needed 9.09 a day, finishing 9 days early (not 89 late)',
      near(t13.required_rate, 100 / 11) && t13.forecast_vs_target === 9 && t13.actual_rate === 300 && near(t13.pct_of_plan, 420), JSON.stringify(t13));

    // A lone "Planned per day" line with no typed target (L7 alone).
    const L7 = jobPatch => ({ projects: [Object.assign({ id: 'l7', 'project-name': 'A', status: 'In Progress', bidItems: [
      { id: 'L7', cost_code: 'Pave', sub_code: 'Surface', unit: 'TON', quantity: '1000', unit_cost: '1', planned_rate: '100' }],
    dailyRows: [row('2026-10-28', 'Pave', 'Surface', 120), row('2026-10-29', 'Pave', 'Surface', 90), row('2026-11-02', 'Pave', 'Surface', 110)] }, jobPatch || {})] });
    const c7 = V.newSection('plan_vs_actual').columns;
    const d7 = V.buildSectionData(pva(c7).sections[0], pva(c7), vmk(pva(c7), L7(), ['l7']));
    const l7 = rowsOf(d7)[0], t7 = J(d7.blocks[0].totals);
    assert('a lone Planned per day line: Totals read its own days ahead (0) and status (On track), not the calendar gap (−4, Behind)',
      l7.ahead_days === 0 && l7.plan_status === 'On track' && t7.ahead_days === 0 && t7.plan_status === 'On track', JSON.stringify({ l7, t7 }));
    const t7e = totOf(pva(c7), L7({ 'end-date': '2026-11-06' }), ['l7']);
    assert('…the same with the job\'s end date as its target (was −4.5, Behind)', t7e.ahead_days === 0 && t7e.plan_status === 'On track', JSON.stringify(t7e));
    const t7c = totOf(pva(c7, { layout: 'combined' }), L7(), ['l7']);
    assert('…and in the combined layout (one job: its Totals are the line\'s)', t7c.ahead_days === 0 && t7c.plan_status === 'On track', JSON.stringify(t7c));
    // Two such lines, both on pace: the job's subtotal is their days of
    // planned output, weighed by bid dollars — not the calendar gap (−3.5).
    const l7c = L7();
    l7c.projects[0].bidItems.push({ id: 'L9', cost_code: 'Pave', sub_code: 'Binder', unit: 'TON', quantity: '1000', unit_cost: '1', planned_rate: '100' });
    ['2026-10-28', '2026-10-29', '2026-11-02', '2026-11-03'].forEach(dt => l7c.projects[0].dailyRows.push(row(dt, 'Pave', 'Binder', 100)));
    l7c.projects.push({ id: 'l7o', 'project-name': 'Other', status: 'In Progress', bidItems: [
      { id: 'O1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '500', unit_cost: '1', start_date: '2026-11-02', target_date: '2026-11-13' }], dailyRows: [] });
    const c7d = V.buildSectionData(pva(c7, { layout: 'combined' }).sections[0], pva(c7, { layout: 'combined' }), vmk(pva(c7, { layout: 'combined' }), l7c, ['l7', 'l7o']));
    const g7 = J(c7d.blocks[0].groups[0]);
    assert('…two Planned per day lines both 0 / On track: their job subtotal reads 0 / On track too (the calendar gap said −3.5, Behind)',
      g7.rows.length === 2 && g7.rows.every(r => r.cells.ahead_days === 0 && r.cells.plan_status === 'On track')
        && g7.subtotal && g7.subtotal.ahead_days === 0 && g7.subtotal.plan_status === 'On track', JSON.stringify(g7.subtotal));
    const scp = J(V.STARTERS.find(x => x.id === 'sub_code_production').definition);
    scp.filters = Object.assign({}, scp.filters, { subCodes: ['Surface'] });
    scp.dates = { preset: 'job_to_date', from: '', to: '' };
    const scd = V.normalizeDefinition(scp);
    const l7b = L7();
    l7b.projects[0].bidItems.push({ id: 'L8', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '1', start_date: '2026-10-01', target_date: '2026-12-01' });
    const sdoc = new JSDOM(V.buildReportHtml(scd, vmk(scd, l7b, ['l7']))).window.document;
    const ptab = sdoc.querySelector('.sec-plan_vs_actual table');
    const trs = ptab ? [...ptab.querySelectorAll('tbody tr, tfoot tr')].map(tr => [...tr.children].map(td => td.textContent.trim())) : [];
    const hd = ptab ? [...ptab.querySelectorAll('thead th')].map(th => th.textContent.trim()) : [];
    const ai = hd.indexOf('Days Ahead / Behind'), si = hd.indexOf('Status');
    assert('…and in the Sub-Code Production starter\'s printout: the Surface line and its Totals both read 0, On track',
      trs.length === 2 && ai > 0 && si > 0 && trs[0][ai] === '0' && trs[1][ai] === '0' && trs[0][si] === 'On track' && trs[1][si] === 'On track',
      JSON.stringify({ hd, trs }));

    // A cost-code-only line beside a cost code + sub code line: the rows they
    // share are counted once in the rates too.
    const F9 = { projects: [{ id: 'f9', 'project-name': 'A', status: 'In Progress', bidItems: [
      { id: 'x1', cost_code: 'Pave', sub_code: '', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-13' },
      { id: 'x2', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '1000', unit_cost: '10', start_date: '2026-11-02', target_date: '2026-11-13' }],
    dailyRows: [row('2026-11-02', 'Pave', 'Top', 100), row('2026-11-03', 'Pave', 'Top', 100)] }] };
    const t9 = totOf(pva(['sub_code', 'installed_to_date', 'planned_rate', 'actual_rate', 'actual_rate_jtd', 'pct_of_plan', 'qty_variance', 'required_rate']), F9, ['f9']);
    assert('lines sharing rows: Totals 200 installed over 2 days is 100 a day (was 200), and % of plan / qty vs plan / needed are blank',
      t9.installed_to_date === 200 && t9.actual_rate === 100 && t9.actual_rate_jtd === 100
        && t9.pct_of_plan === null && t9.qty_variance === null && t9.required_rate === null, JSON.stringify(t9));
  }

  // ── Division rates ──
  const RATES = () => ({
    projects: [{ id: 'rp', 'project-name': 'Rate Job', 'job-number': 'R1', bidItems: [
      { id: 'R1', cost_code: 'Paving', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '50' },
      { id: 'R2', cost_code: 'Paving', sub_code: 'Surface', unit: 'TN', quantity: '500', unit_cost: '60' },
      { id: 'R3', cost_code: 'Milling', sub_code: 'Mill', unit: 'SY', quantity: '2000', unit_cost: '2' },
    ], dailyRows: [
      row('2026-11-02', 'Paving', 'Base', 100, { employee: 'A', equip_hours: '6' }),
      row('2026-11-02', 'Paving', 'Base', 0, { employee: 'B' }),
      row('2026-11-02', 'Paving', 'Surface', 50, { employee: 'C' }),
      row('2026-11-02', 'Paving', 'Base', 30, { employee: 'D', labor_hours: '4', field_type: 'Haul — On Site', equip_hours: '4' }),
      row('2026-11-02', 'Paving', 'Base', 12, { employee: 'Driver Dan', labor_hours: '0', job_class: 'Trucking', equip_hours: '8' }),
      row('2026-11-03', 'Paving', 'Base', 150, { employee: 'A', labor_hours: '10' }),
      row('2026-11-03', 'Paving', 'Base', 0, { employee: 'B', labor_hours: '10' }),
      row('2026-11-03', 'Paving', 'Base', 0, { employee: 'A', labor_hours: '1', field_type: 'Travel' }),
      row('2026-11-03', 'Milling', 'Mill', 800, { employee: 'E' }),
      row('2026-10-20', 'Paving', 'Base', 400, { employee: 'A' }),
    ] },
    { id: 'rp2', 'project-name': 'Rate Job Two', bidItems: [{ id: 'S1', cost_code: 'Paving', sub_code: 'Base', unit: 'TON', quantity: '300', unit_cost: '50' }],
      dailyRows: [row('2026-11-04', 'Paving', 'Base', 100, { employee: 'X' })] }],
    trucks: [
      { id: 't1', tr_number: 'TR-1', project_id: 'rp', date: '2026-11-02', loads: '10', cost_code: 'Paving', sub_code: 'Base' },
      { id: 't2', tr_number: 'TR-2', project_id: 'rp', date: '2026-11-03', loads: '5' },
      { id: 't3', tr_number: 'TR-3', project_id: 'rp', date: '2026-11-03', loads: '7', cost_code: 'Milling', sub_code: 'Mill' },
      { id: 't4', tr_number: 'TR-4', project_id: 'rp', date: '2026-10-20', loads: '99', cost_code: 'Paving', sub_code: 'Base' },
      { id: 't5', tr_number: 'TR-5', project_id: 'rp2', date: '2026-11-04', loads: '4', cost_code: 'Paving', sub_code: 'Base' },
    ],
  });
  const TURF = () => ({ projects: [{ id: 'rt', 'project-name': 'Turf Rate Job', bidItems: [
    { id: 'B1', cost_code: 'Turf', sub_code: 'Base Prep', unit: 'sq ft', quantity: '5000', unit_cost: '1' },
    { id: 'B2', cost_code: 'Turf', sub_code: 'Turf Install', unit: 'SF', quantity: '8000', unit_cost: '1' },
    { id: 'B3', cost_code: 'Turf', sub_code: 'Edging', unit: 'LF', quantity: '300', unit_cost: '1' },
  ], dailyRows: [
    row('2026-11-02', 'Turf', 'Turf Install', 1000, { employee: 'A' }), row('2026-11-02', 'Turf', 'Turf Install', 0, { employee: 'B' }),
    row('2026-11-03', 'Turf', 'Turf Install', 1500, { employee: 'A' }), row('2026-11-03', 'Turf', 'Turf Install', 0, { employee: 'B', labor_hours: '6' }),
    row('2026-11-03', 'Turf', 'Turf Install', 0, { employee: 'C', labor_hours: '3', field_type: 'Haul — To/From Site' }),
    row('2026-11-02', 'Turf', 'Base Prep', 3000, { employee: 'C' }), row('2026-11-03', 'Turf', 'Edging', 200, { employee: 'D', labor_hours: '4' }),
  ] }] });
  const KIEWIT = () => ({ projects: [{ id: 'rk', 'project-name': 'Home Job', bidItems: [
    { id: 'K1', cost_code: 'Homes', sub_code: 'Set Home', unit: 'EA', quantity: '20', unit_cost: '1' },
    { id: 'K2', cost_code: 'Homes', sub_code: 'Skirting', unit: 'ea', quantity: '10', unit_cost: '1' },
  ], dailyRows: [
    row('2026-11-02', 'Homes', 'Set Home', 2, { employee: 'A', labor_hours: '10' }), row('2026-11-02', 'Homes', 'Set Home', 0, { employee: 'B', labor_hours: '10' }),
    row('2026-11-03', 'Homes', 'Set Home', 1, { employee: 'A', labor_hours: '9' }), row('2026-11-03', 'Homes', 'Set Home', 0, { employee: 'B', labor_hours: '9' }),
    row('2026-11-03', 'Homes', 'Set Home', 0, { employee: 'C', labor_hours: '2', field_type: 'Travel' }),
    row('2026-11-04', 'Homes', 'Set Home', 0, { employee: 'A', labor_hours: '4.1' }), row('2026-11-04', 'Homes', 'Skirting', 3, { employee: 'D', labor_hours: '6' }),
  ] }] });

  section('Division rates — paving, turf, kiewit');
  {
    const rateDef = (patch, defPatch) => vdef([vsec('rate_summary', Object.assign({ columns: allCols('rate_summary') }, patch || {}))],
      Object.assign({ includeInternal: true, dates: { preset: 'this_week' } }, defPatch || {}));
    const rr = (def, data, ids, div) => V.buildSectionData(def.sections[0], def, vmk(def, data, ids, null, divCfg(div)));
    const pav = rr(rateDef(), RATES(), ['rp'], 'paving');
    const p = rowsOf(pav)[0];
    // This week (Nov 2–8): TON rows 100 + 50 (TN) + 150 = 300; the haul row's
    // 30 and the trucking ticket's 12 are not tons placed; Oct 20 is outside.
    assert('paving tons = TON and TN lines\' quantity, no haul rows, no trucking tickets\' loads: 300 over 2 days = 150 a day',
      p.tons_period === 300 && p.work_days === 2 && p.tons_per_day === 150, J(p));
    assert('loads = the job\'s tickets in the range (10 + 5 + 7); 300 ÷ 22 tons a load',
      p.loads_period === 22 && near(p.tons_per_load, 300 / 22));
    // Shifts: Nov 2 (8 + 8 + 8) ÷ 3 = 8; Nov 3 (10 + 10) ÷ 2 = 10 — travel and haul out.
    assert('tons per crew-hour = 300 ÷ (8 + 10) shift hours; per equip-hour 300 ÷ 6 (haul and truck hours out); avg crew (3 + 2) ÷ 2',
      near(p.tons_per_crew_hr, 300 / 18) && p.tons_per_equip_hr === 50 && p.avg_crew === 2.5, J(p));
    assert('the paving strip shows only paving\'s tiles; a caption names where loads come from',
      pav.columns.map(c => c.key).join() === 'work_days,avg_crew,tons_period,tons_per_day,loads_period,tons_per_load,tons_per_crew_hr,tons_per_equip_hr'
        && JSON.stringify(pav.blocks[0].notes) === '["Loads from trucking tickets."]');
    // TN and TON (the units list offers both) are one unit to the Production
    // Rates totals too, as to Planned vs Actual and Division Rates beside them.
    {
      const TT = { projects: [{ id: 'tt', 'project-name': 'Main St', status: 'In Progress', 'start-date': '2026-10-01', 'end-date': '2026-11-30', bidItems: [
        { id: 't1', cost_code: '200', sub_code: 'BASE', unit: 'TN', quantity: '1000', unit_cost: '80', start_date: '2026-10-05', target_date: '2026-10-30' },
        { id: 't2', cost_code: '200', sub_code: 'SURF', unit: 'TON', quantity: '600', unit_cost: '95', start_date: '2026-10-19', target_date: '2026-11-13' }],
      dailyRows: [row('2026-10-05', '200', 'BASE', 300, { employee: 'A', equip_hours: '8' }), row('2026-10-05', '200', 'BASE', 0, { employee: 'B' }),
        row('2026-10-06', '200', 'BASE', 250, { employee: 'A', equip_hours: '8' }), row('2026-10-20', '200', 'SURF', 200, { employee: 'A', labor_hours: '10', equip_hours: '6' })] }],
      trucks: [{ id: 'tk1', project_id: 'tt', date: '2026-10-05', loads: '15', cost_code: '200', sub_code: 'BASE' },
        { id: 'tk2', project_id: 'tt', date: '2026-10-06', loads: '12', cost_code: '200', sub_code: 'BASE' },
        { id: 'tk3', project_id: 'tt', date: '2026-10-20', loads: '10', cost_code: '200', sub_code: 'SURF' }] };
      const tdef = vdef([vsec('production_kpis', { columns: allCols('production_kpis'), options: { totals: true } }),
        vsec('plan_vs_actual', { columns: allCols('plan_vs_actual') }), vsec('rate_summary', { columns: allCols('rate_summary') })],
      { includeInternal: true, dates: { preset: 'job_to_date', from: '', to: '' } });
      const tctx = vmk(tdef, TT, ['tt'], { today: '2026-11-06' }, divCfg('paving'));
      const pk = J(V.buildSectionData(tdef.sections[0], tdef, tctx).blocks[0].totals);
      const pv = J(V.buildSectionData(tdef.sections[1], tdef, tctx).blocks[0].totals);
      const rs = J(rowsOf(V.buildSectionData(tdef.sections[2], tdef, tctx))[0]);
      assert('Production Rates totals over a TN line and a TON line: 750 in one unit, 250 a day, best day 300, 750 ÷ 37 loads',
        pk.qty_period === 750 && pk.avg_per_day === 250 && pk.best_day === 300 && near(pk.per_load, 750 / 37) && pk.unit === 'TN', JSON.stringify(pk));
      assert('…its units per crew-hour and equip-hour are Planned vs Actual\'s and Division Rates\' (750 ÷ 26, 750 ÷ 22)',
        near(pk.units_per_crew_hr, 750 / 26) && near(pk.units_per_crew_hr, pv.units_per_crew_hr) && near(pk.units_per_crew_hr, rs.tons_per_crew_hr)
          && near(pk.units_per_equip_hr, 750 / 22) && near(pk.units_per_equip_hr, rs.tons_per_equip_hr), JSON.stringify({ pk, pv: pv.units_per_crew_hr, rs }));
    }
    const f = rowsOf(rr(rateDef(null, { filters: { costCodes: [], subCodes: ['base'] } }), RATES(), ['rp'], 'paving'))[0];
    assert('under a sub-code filter: Base only (250 tons); a ticket with codes must pass it, one without still counts (10 + 5)',
      f.tons_period === 250 && f.loads_period === 15 && near(f.tons_per_load, 250 / 15) && near(f.tons_per_crew_hr, 250 / 18), J(f));
    const turf = rr(rateDef(), TURF(), ['rt'], 'turf');
    const t = rowsOf(turf)[0];
    assert('turf: SF measured on ONE line — Turf Install, the most bid quantity — never Base Prep added in: 2,500 SF over 2 days',
      t.sf_period === 2500 && t.work_days === 2 && t.sf_per_day === 1250 && JSON.stringify(turf.blocks[0].notes)
        === '["SF measured on Turf Install — pick a sub code to change it."]', J(t));
    assert('turf SF per man-hour = 2,500 ÷ 30 (the haul hours out); only turf tiles', near(t.sf_per_mh, 2500 / 30)
      && turf.columns.map(c => c.key).join() === 'work_days,avg_crew,sf_period,sf_per_day,sf_per_mh');
    const tb = rowsOf(rr(rateDef(null, { filters: { subCodes: ['Base Prep'] } }), TURF(), ['rt'], 'turf'))[0];
    assert('…pick a sub code and that line is measured ("sq ft" reads as SF): 3,000 SF, 375 a man-hour, no caption',
      tb.sf_period === 3000 && tb.sf_per_mh === 375 && tb.work_days === 1);
    const kw = rr(rateDef(), KIEWIT(), ['rk'], 'kiewit');
    const k = rowsOf(kw)[0];
    assert('kiewit: homes on the EA line with the most bid quantity: 3 homes over 3 days; man-hours per home 42.1 ÷ 3 (travel out)',
      k.homes_period === 3 && k.work_days === 3 && k.homes_per_day === 1 && near(k.mh_per_home, 42.1 / 3)
        && kw.blocks[0].notes[0] === 'Homes measured on Set Home — pick a sub code to change it.', J(k));
    // A trucking ticket written into the daily rows (its quantity is loads)
    // and a haul row, both on the measured line: not homes / SF, not a work day.
    const TRK = unit => ({ projects: [{ id: 'tk', 'project-name': 'Truck Job', bidItems: [
      { id: 'h1', cost_code: 'Work', sub_code: 'Main', unit, quantity: '40', unit_cost: '5000' }],
    dailyRows: [
      row('2026-11-02', 'Work', 'Main', 2, { employee: 'A' }), row('2026-11-03', 'Work', 'Main', 3, { employee: 'A' }),
      row('2026-11-03', 'Work', 'Main', 4, { employee: 'Driver D', job_class: 'Trucking', labor_hours: '0', equip_hours: '6' }),
      row('2026-11-04', 'Work', 'Main', 2, { employee: 'Driver D', job_class: 'Trucking', labor_hours: '0', equip_hours: '5' }),
      row('2026-11-05', 'Work', 'Main', 0, { employee: 'H', field_type: 'Haul — To/From Site', labor_hours: '3' }),
    ] }] });
    const kt = rr(rateDef(), TRK('EA'), ['tk'], 'kiewit');
    const ktr = rowsOf(kt)[0];
    assert('kiewit: trucking-ticket loads and haul rows on Homes are not homes set nor work days — 5 homes over 2 days, 16 man-hours ÷ 5',
      ktr.homes_period === 5 && ktr.work_days === 2 && ktr.homes_per_day === 2.5 && near(ktr.mh_per_home, 16 / 5)
        && kt.blocks[0].notes.includes('Trucking and haul rows are not counted as homes set.'), JSON.stringify({ ktr, notes: kt.blocks[0].notes }));
    const tt = rr(rateDef(), TRK('SF'), ['tk'], 'turf');
    const ttr = rowsOf(tt)[0];
    assert('turf: the same on the SF line — 5 SF over 2 days (the haul-only day is no work day), 5 ÷ 16 SF a man-hour',
      ttr.sf_period === 5 && ttr.work_days === 2 && near(ttr.sf_per_mh, 5 / 16)
        && tt.blocks[0].notes.includes('Trucking and haul rows are not counted as SF installed.'), JSON.stringify({ ttr, notes: tt.blocks[0].notes }));
    const comb = rr(rateDef(null, { layout: 'combined' }), RATES(), ['rp', 'rp2'], 'paving');
    const crow = comb.blocks[0].groups[0].rows;
    assert('combined: a strip per job and an All jobs strip — sums, rates worked out again from them',
      crow.length === 3 && crow[2].all === true && crow[0].job.id === 'rp' && crow[2].cells.tons_period === 400 && crow[2].cells.work_days === 3
        && near(crow[2].cells.tons_per_day, 400 / 3) && crow[2].cells.loads_period === 26 && near(crow[2].cells.tons_per_load, 400 / 26)
        && near(crow[2].cells.tons_per_crew_hr, 400 / 26), J(crow.map(x => x.cells)));
    const html = V.buildReportHtml(rateDef(null, { layout: 'combined' }), vmk(rateDef(null, { layout: 'combined' }), RATES(), ['rp', 'rp2'], null, divCfg('paving')));
    const doc = new JSDOM(html).window.document;
    assert('…printed as KPI strips with job headings', [...doc.querySelectorAll('.sec-rate_summary .kpi-h')].map(e => e.textContent).join('|')
      === 'Rate Job · R1|Rate Job Two|All jobs' && doc.querySelectorAll('.sec-rate_summary .sum-bar').length === 3);
    const none = rowsOf(rr(rateDef(), RATES(), ['rp'], undefined))[0];
    assert('with no division known, only the common tiles exist', Object.keys(none).join() === 'work_days,avg_crew');
    // Per-item rate columns on Production Rates.
    const pk = vdef([vsec('production_kpis', { columns: allCols('production_kpis'), options: { totals: true } })], { includeInternal: true, dates: { preset: 'this_week' } });
    const pr = rowsOf(V.buildSectionData(pk.sections[0], pk, vmk(pk, RATES(), ['rp'])));
    const base = byKey(pr, 'sub_code', 'Base'), surf = byKey(pr, 'sub_code', 'Surface'), mill = byKey(pr, 'sub_code', 'Mill');
    assert('Per Load on a TON line: 250 tons placed ÷ 10 loads on its tickets = 25; none on a line without tickets or not in tons',
      base.per_load === 25 && surf.per_load === null && mill.per_load === null && base.qty_period === 292, J(base));
    assert('Units / Crew-Hour 250 ÷ 18, Units / Equip-Hour 250 ÷ 6 (internal)', near(base.units_per_crew_hr, 250 / 18) && near(base.units_per_equip_hr, 250 / 6)
      && surf.units_per_crew_hr === 6.25 && mill.units_per_crew_hr === 100 && mill.units_per_equip_hr === null);
    const one = vdef([vsec('production_kpis', { columns: allCols('production_kpis'), options: { totals: true, subCodes: ['Base'] } })],
      { includeInternal: true, dates: { preset: 'this_week' } });
    const ot = V.buildSectionData(one.sections[0], one, vmk(one, RATES(), ['rp'])).blocks[0].totals;
    assert('…and in the totals when one unit (tickets and rows each counted once)', ot.per_load === 25 && near(ot.units_per_crew_hr, 250 / 18));
  }

  section('Sub-code and cost-code filters — every section');
  {
    const d = fixture();
    const types = ['summary_kpis', 'bid_progress', 'production_kpis', 'daily_production', 'materials', 'trucking', 'change_orders', 'schedule',
      'plan_vs_actual', 'chart', 'rate_summary'];
    for (const layout of ['separate', 'combined']) {
      const def = vdef(types.map(t => vsec(t, t === 'chart' ? { options: { chart: 'daily_bars' } } : {})),
        { layout, filters: { costCodes: [], subCodes: ['base course'] } });
      const ctx = vmk(def, d, ['p1', 'p2']);
      const sd = t => V.buildSectionData(def.sections[types.indexOf(t)], def, ctx);
      const all = t => sd(t).blocks.flatMap(b => b.groups.flatMap(g => g.rows.map(r => r.cells)));
      const notes = t => sd(t).blocks.flatMap(b => b.notes || []);
      assert(`${layout}: bid progress lists Base Course only (case-blind match), and says it hid the cost-code-only lines (Striping; Sealcoat on job 2)`,
        all('bid_progress').map(r => r.sub_code).join() === 'Base Course' && (layout === 'combined'
          ? JSON.stringify(notes('bid_progress')) === '["2 cost-code-only items hidden by the sub-code filter."]'
          : JSON.stringify(notes('bid_progress')) === '["1 cost-code-only item hidden by the sub-code filter.","1 cost-code-only item hidden by the sub-code filter."]'),
        J(notes('bid_progress')));
      assert(`${layout}: production rates, plan vs actual and schedule likewise`,
        all('production_kpis').map(r => r.sub_code).join() === 'Base Course' && all('plan_vs_actual').map(r => r.sub_code).join() === 'Base Course'
          && all('schedule').length === 0 && notes('plan_vs_actual').filter(n => /^Planned figures/.test(n)).length === 1
          && notes('plan_vs_actual').some(n => /1 of 1 item has no plan/.test(n)));
      assert(`${layout}: daily rows on Base Course only`, all('daily_production').length > 0 && all('daily_production').every(r => r.sub_code === 'Base Course'));
      assert(`${layout}: materials on the PO's codes (Base Course PO kept, the uncoded one dropped); trucking on the ticket's (none pass)`,
        all('materials').map(r => r.invoice_num).sort().join() === 'T-400,T-501,T-502' && all('trucking').length === 0);
      assert(`${layout}: change orders on their bid item's codes; contract change orders hidden, and counted`,
        all('change_orders').map(r => r.number).join() === 'Q-1' && notes('change_orders').includes('1 contract change order hidden by the code filter.'));
      const kpis = sd('summary_kpis');
      const k = all('summary_kpis');
      const labels = kpis.columns.map(c => c.label);
      assert(`${layout}: the summary strip's quantity, % complete and items complete are the filtered items', labelled (filtered)`,
        k[0].qty_period === 1050 && k[0].items_complete === '0 of 1' && near(k[0].pct_complete, 50)
          && labels.includes('% Complete (filtered)') && labels.includes('Qty Installed (filtered)') && labels.includes('Bid Items Complete (filtered)')
          && labels.includes('Days Worked'), J(k));
      const bars = sd('chart').blocks.flatMap(b => b.charts).filter(ch => ch.job.id === 'p1')[0];
      assert(`${layout}: the chart draws Base Course only (1,050 TON in daily bars)`, bars.bars.reduce((t, b) => t + b.qty, 0) === 1050 && bars.unit === 'TON');
      assert(`${layout}: the division rates count Base Course tons only`, all('rate_summary').some(r => r.tons_period === 1050)
        && all('rate_summary').every(r => r.tons_period === 1050 || r.tons_period === 0));
    }
    const both = vdef([vsec('bid_progress', { options: { subCodes: ['Surface Course'] } })], { filters: { subCodes: ['Base Course'] } });
    assert('a section\'s own sub codes AND the report\'s: Surface ∩ Base → nothing',
      rowsOf(V.buildSectionData(both.sections[0], both, vmk(both, d, ['p1']))).length === 0);
    const secOnly = vdef([vsec('bid_progress', { options: { subCodes: ['Surface Course'], groupBy: 'none' } })]);
    const so = V.buildSectionData(secOnly.sections[0], secOnly, vmk(secOnly, d, ['p1']));
    assert('a section-level sub-code filter alone works the same way', rowsOf(so).map(r => r.sub_code).join() === 'Surface Course'
      && so.blocks[0].notes.length === 1);
    const cc = vdef([vsec('bid_progress', { options: { groupBy: 'none' } }), vsec('summary_kpis')], { filters: { costCodes: ['striping'] } });
    const ccs = V.buildSectionData(cc.sections[0], cc, vmk(cc, d, ['p1']));
    assert('a cost-code filter keeps a cost-code-only line (no sub-code filter, no footnote)',
      rowsOf(ccs).map(r => r.cost_code).join() === 'Striping' && !ccs.blocks[0].notes.length
        && V.buildSectionData(cc.sections[1], cc, vmk(cc, d, ['p1'])).columns.some(c => c.label === '% Complete (filtered)'));
    const html = V.buildReportHtml(vdef([vsec('bid_progress')], { filters: { subCodes: ['Base Course'] } }),
      vmk(vdef([vsec('bid_progress')], { filters: { subCodes: ['Base Course'] } }), d, ['p1']));
    const fwb = workbook(V.buildXlsx(vdef([vsec('bid_progress')], { filters: { subCodes: ['Base Course'] } }),
      vmk(vdef([vsec('bid_progress')], { filters: { subCodes: ['Base Course'] } }), d, ['p1'])));
    assert('the footnote prints under the table and as a note row in the XLSX',
      /<p class="fnote">1 cost-code-only item hidden by the sub-code filter\.<\/p>/.test(html)
        && Object.values(fwb.sheets['Bid Item Progress']).some(c => c.v === '1 cost-code-only item hidden by the sub-code filter.'));
    const plain = vdef([vsec('bid_progress')]);
    assert('no filter: nothing hidden, no footnote, the strip unlabelled', !/class="fnote"/.test(V.buildReportHtml(plain, vmk(plain, d, ['p1']))));
  }

  section('Charts — figures, safety, caps');
  {
    // Daily bars: Oct 26 – Nov 5; TON lines (1,500 bid) outnumber SY (100).
    const db = { projects: [{ id: 'db', 'project-name': 'Bars Job', bidItems: [
      { id: 'D1', cost_code: 'Pave', sub_code: 'Base', unit: 'TON', quantity: '1000', unit_cost: '1', start_date: '2026-11-02', target_date: '2026-11-13' },
      { id: 'D2', cost_code: 'Pave', sub_code: 'Top', unit: 'TON', quantity: '500', unit_cost: '1' },
      { id: 'D3', cost_code: 'Misc', sub_code: 'X', unit: 'SY', quantity: '100', unit_cost: '1' },
    ], dailyRows: [
      row('2026-10-31', 'Pave', 'Base', 40, { employee: 'A' }), row('2026-11-02', 'Pave', 'Base', 100, { employee: 'A' }),
      row('2026-11-02', 'Pave', 'Base', 0, { employee: 'B', labor_hours: '6' }), row('2026-11-03', 'Pave', 'Base', 120, { employee: 'A' }),
      row('2026-11-03', 'Pave', 'Top', 30, { employee: 'A' }), row('2026-11-04', 'Pave', 'Top', 50, { employee: 'A' }),
      row('2026-11-04', 'Misc', 'X', 999, { employee: 'Z' }),
    ] }] };
    const barDef = (cols, defPatch) => vdef([vsec('chart', { columns: cols || V.newSection('chart').columns, options: { chart: 'daily_bars' } })],
      Object.assign({ dates: { preset: 'custom', from: '2026-10-26', to: '2026-11-05' } }, defPatch || {}));
    const bd = barDef();
    const bsd = V.buildSectionData(bd.sections[0], bd, vmk(bd, db, ['db']));
    const ch = bsd.blocks[0].charts[0];
    assert('daily bars: every working day in the period plus a Saturday with work — 10 bars, TON only, mixed units captioned',
      ch.bars.length === 10 && ch.bars.map(b => b.qty).join() === '0,0,0,0,0,40,100,150,50,0' && ch.unit === 'TON'
        && ch.captions[0] === 'Showing the TON items only — the unit with the most bid quantity.', J(ch.bars.map(b => [b.from, b.qty])));
    assert('…with the planned rate of the planned lines (1,000 over 9 working days)', near(ch.rate, 1000 / 9) && ch.drawPlan && ch.bars.every(b => near(b.plan, 1000 / 9)));
    const bh = V.buildReportHtml(bd, vmk(bd, db, ['db']));
    const bdoc = new JSDOM(bh).window.document;
    const fig = bdoc.querySelector('figure.crc');
    const barPath = [...fig.querySelectorAll('path')].find(p => p.getAttribute('fill') === '#86efac');
    assert('…drawn as one path of 4 bar rectangles (zero days draw none), a dashed plan line, no crew line while customer-safe',
      barPath && (barPath.getAttribute('d').match(/Z/g) || []).length === 4 && [...fig.querySelectorAll('path')].some(p => p.getAttribute('stroke-dasharray'))
        && !/crew hours/i.test(bh) && !fig.querySelector('path[stroke="#9333ea"]'));
    const ib = barDef(allCols('chart'), { includeInternal: true });
    const ich = V.buildSectionData(ib.sections[0], ib, vmk(ib, db, ['db'])).blocks[0].charts[0];
    assert('with internal data on and crew hours chosen: a crew-hours line (shift length a day: Nov 2 (8 + 6) ÷ 2 = 7; Nov 3 one man, 8 + 8 = 16)',
      ich.drawCrew && ich.bars[6].crew === 7 && ich.bars[7].crew === 16 && /crew hours/i.test(V.buildReportHtml(ib, vmk(ib, db, ['db']))));
    const wb = workbook(V.buildXlsx(bd, vmk(bd, db, ['db'])));
    const cd = wb.sheets['Chart data'];
    const head = ['Date', 'Daily qty', 'Planned / day'].map(h => findCell(cd, h));
    assert('XLSX: a Chart data sheet — Date, Daily qty, Planned / day; no Crew hours column while customer-safe',
      head.every(Boolean) && !findCell(cd, 'Crew hours') && cd[head[0].col + (head[0].row + 7)].v === serial('2026-11-02')
        && cd[head[1].col + (head[1].row + 7)].v === 100 && near(cd[head[2].col + (head[2].row + 1)].v, 1000 / 9, 1e-4)
        && Object.values(cd).some(c => c.v === 'Showing the TON items only — the unit with the most bid quantity.'));
    const iwb = workbook(V.buildXlsx(ib, vmk(ib, db, ['db'])));
    assert('…and a Crew hours column once it may print', !!findCell(iwb.sheets['Chart data'], 'Crew hours'));
    // Two jobs whose charts differ: a short job charted by the day / in
    // quantity, a long one by the week / in % (mixed units). Each job's rows
    // sit under their own header, in their own number format.
    {
      const wkRows = (from, n, cc, sc) => { const out = []; let t = Date.parse(from + 'T00:00:00Z'), k = 0;
        while (k < n) { const dt = new Date(t), w = dt.getUTCDay(); if (w && w < 6) { out.push(row(dt.toISOString().slice(0, 10), cc, sc, 100)); k++; } t += 86400000; }
        return out; };
      const two = { projects: [
        { id: 'sj', 'project-name': 'Short Job', status: 'In Progress', bidItems: [
          { id: 'x1', cost_code: 'Turf', sub_code: 'Install', unit: 'SF', quantity: '10000', unit_cost: '2', start_date: '2026-10-12', target_date: '2026-12-18' }],
        dailyRows: wkRows('2026-10-12', 15, 'Turf', 'Install') },
        { id: 'lj', 'project-name': 'Long Job', status: 'In Progress', bidItems: [
          { id: 'y1', cost_code: 'Turf', sub_code: 'Install', unit: 'SF', quantity: '20000', unit_cost: '2', start_date: '2026-06-01', target_date: '2026-12-18' },
          { id: 'y2', cost_code: 'Edge', sub_code: 'Trim', unit: 'LF', quantity: '500', unit_cost: '2', start_date: '2026-06-01', target_date: '2026-12-18' }],
        dailyRows: wkRows('2026-06-01', 100, 'Turf', 'Install') }] };
      for (const layout of ['separate', 'combined']) {
        const heads = (chart) => {
          const def = vdef([vsec('chart', { columns: ['installed', 'plan', 'daily_qty', 'planned_rate_line'], options: { chart, basis: 'qty' } })], { layout });
          const ctx = vmk(def, two, ['sj', 'lj'], null, divCfg('turf'));
          const kinds = J(V.buildSectionData(def.sections[0], def, ctx).blocks.flatMap(b => b.charts).map(ch => ch.bucket || ch.basis));
          const w = workbook(V.buildXlsx(def, ctx));
          const sh = w.sheets['Chart data'];
          const refs = Object.keys(sh).filter(r => /^A\d+$/.test(r)).sort((a, b) => +a.slice(1) - +b.slice(1));
          // Each header row, and the job name on the first data row under it.
          const out = [];
          refs.forEach(r => { if (sh[r].v === 'Job') { const n = +r.slice(1); out.push({ n, head: ['B', 'C', 'D'].map(c => sh[c + n] && sh[c + n].v),
            job: sh['A' + (n + 1)] && sh['A' + (n + 1)].v, fmt: w.styles[sh['C' + (n + 1)] && sh['C' + (n + 1)].s] }); } });
          return { kinds, out };
        };
        const b = heads('daily_bars');
        assert(`${layout}: Chart data — the daily job under Date | Daily qty | Planned / day, the weekly one under Week of | Weekly qty | Planned / week`,
          b.kinds.join() === 'day,week' && b.out.length === 2 && b.out[0].head.join('|') === 'Date|Daily qty|Planned / day' && b.out[0].job === 'Short Job'
            && b.out[1].head.join('|') === 'Week of|Weekly qty|Planned / week' && b.out[1].job === 'Long Job', JSON.stringify(b));
        const c = heads('s_curve');
        assert(`${layout}: …the S-curve in quantity under Installed (cum), the one in % under Installed (cum %) with a percent format`,
          c.kinds.join() === 'qty,pct' && c.out.length === 2 && c.out[0].head.slice(0, 2).join('|') === 'Date|Installed (cum)' && c.out[0].job === 'Short Job'
            && !/%/.test(c.out[0].fmt || '') && c.out[1].head.slice(0, 2).join('|') === 'Date|Installed (cum %)' && c.out[1].job === 'Long Job'
            && /%/.test(c.out[1].fmt || ''), JSON.stringify(c));
      }
    }

    // S-curve on the plan fixture: its end figures are Planned vs Actual's totals.
    const sdef = vdef([vsec('plan_vs_actual'), vsec('chart')]);
    const sctx = vmk(sdef, PV(), ['pv']);
    const tot = V.buildSectionData(sdef.sections[0], sdef, sctx).blocks[0].totals;
    const sc = V.buildSectionData(sdef.sections[1], sdef, sctx).blocks[0].charts[0];
    const atA = sc.points.find(pt => pt.date === TODAY);
    assert('S-curve (% basis, plan drawn): at the as-of day, installed = the totals\' earned %, planned = their scheduled %',
      atA && near(atA.inst, tot.earned_pct, 1e-6) && near(atA.plan, tot.sched_pct, 1e-6) && sc.basis === 'pct', `${atA && atA.inst} vs ${tot.earned_pct}; ${atA && atA.plan} vs ${tot.sched_pct}`);
    assert('…from the day before the earliest start to the last target, rising from zero, planned to 100%',
      sc.start === '2026-10-11' && sc.end === '2026-11-20' && sc.points[0].inst === 0 && sc.points[0].plan === 0
        && sc.points[sc.points.length - 1].plan === 100 && sc.points[sc.points.length - 1].inst === null
        && sc.captions[0] === 'Covers the 7 of 8 items with a plan.', J([sc.start, sc.end, sc.captions]));
    const qd = vdef([vsec('chart', { options: { basis: 'qty' } })]);
    const qc = V.buildSectionData(qd.sections[0], qd, vmk(qd, PV(), ['pv'])).blocks[0].charts[0];
    assert('qty basis with mixed units falls back to % and says so', qc.basis === 'pct' && /different units/.test(qc.captions.join(' ')));
    const one = { projects: [{ id: 'q1', 'project-name': 'Q', bidItems: [PV().projects[0].bidItems[0]], dailyRows: PV().projects[0].dailyRows }] };
    const qq = V.buildSectionData(qd.sections[0], qd, vmk(qd, one, ['q1'])).blocks[0].charts[0];
    const qa = qq.points.find(pt => pt.date === TODAY);
    assert('qty basis on one unit: 450 SY in at the as-of day against 444.4 planned', qq.basis === 'qty' && qa.inst === 450 && near(qa.plan, 4000 / 9) && qq.unit === 'SY');
    const noPlan = vdef([vsec('chart', { columns: ['installed'] })]);
    const np = V.buildSectionData(noPlan.sections[0], noPlan, vmk(noPlan, PV(), ['pv'])).blocks[0].charts[0];
    assert('with the plan column off, no plan is drawn and the curve covers every item', !np.drawPlan && np.points.every(pt => pt.plan === null) && !np.captions.length);
    const nothing = vdef([vsec('chart', { columns: ['daily_qty'] })]);
    assert('an S-curve whose own series are all off prints nothing', !/sec-chart/.test(V.buildReportHtml(nothing, vmk(nothing, PV(), ['pv']))));

    // Hostile names, long spans: what the SVG may contain.
    const evil = 'Evil <script>alert(1)</script> onload=alert(2) " onmouseover="x" url(javascript:alert(3)) href=x';
    const long = { projects: [{ id: 'lg', 'project-name': evil, 'job-number': 'a=b', bidItems: [
      { id: 'G1', cost_code: 'Long', sub_code: 'Run onclick=x', unit: 'L=F', quantity: '100000', unit_cost: '1', start_date: '2024-01-08', target_date: '2027-12-31' },
      { id: 'G2', cost_code: 'Long', sub_code: 'Walk', unit: 'L=F', quantity: '5000', unit_cost: '1' }],
    dailyRows: [] }, { id: 'lg2', 'project-name': 'Second <b>job</b>', bidItems: [{ id: 'H1', cost_code: 'Long', sub_code: 'Run onclick=x', unit: 'L=F', quantity: '10', unit_cost: '1' }],
    dailyRows: [row('2026-11-02', 'Long', 'Run onclick=x', 3)] }] };
    for (let t = Date.UTC(2024, 0, 8); t <= Date.UTC(2026, 10, 4); t += 86400000) {
      const dt = new Date(t), w = dt.getUTCDay();
      if (w !== 0 && w !== 6) long.projects[0].dailyRows.push(row(dt.toISOString().slice(0, 10), 'Long', 'Run onclick=x', 50, { employee: 'E' + (t % 7) }));
    }
    long.projects[0].dailyRows.push(row('2026-11-01', 'Long', 'Walk', 10));
    const charts = [];
    const sanit = require(path.join(ROOT, 'api/lib/email.js')).sanitizeReportHtml;
    for (const layout of ['separate', 'combined']) {
      for (const [opts, preset] of [[{ chart: 's_curve', basis: 'pct' }, 'job_to_date'], [{ chart: 's_curve', basis: 'qty' }, 'job_to_date'],
        [{ chart: 'daily_bars' }, 'job_to_date'], [{ chart: 'daily_bars' }, 'last_30'], [{ chart: 'daily_bars', height: 'tall' }, 'custom']]) {
        const def = vdef([vsec('chart', { columns: allCols('chart'), options: opts })],
          { layout, includeInternal: true, dates: { preset, from: '2026-01-01', to: '2026-11-05' } });
        const ctx = vmk(def, long, ['lg', 'lg2']);
        const sdc = V.buildSectionData(def.sections[0], def, ctx);
        const html = V.buildReportHtml(def, ctx);
        charts.push({ layout, opts, preset, sd: sdc, html, figs: (html.match(/<figure class="crc">[\s\S]*?<\/figure>/g) || []) });
      }
    }
    const figs = charts.flatMap(c => c.figs);
    assert('hostile job and code names: 20 charts drawn', figs.length === 20, figs.length);
    const banned = [/url\(/i, /<image/i, /foreignObject/i, /<script/i, /\son[a-z]+\s*=/i, /\shref\s*=/i, /\ssrc\s*=/i, /xlink/i, /<a[\s>]/i];
    const hits = figs.flatMap(f => banned.filter(re => re.test(f)).map(String));
    assert('no url(, <image>, foreignObject, script, on…= attribute or text, href or src anywhere in a chart', !hits.length, [...new Set(hits)].join(' '));
    assert('an = in a person\'s text (job #, sub code, unit) is written &#61; in the chart and its caption',
      figs.every(f => !/=/.test(f.replace(/="[^"]*"/g, '')))
        && charts.some(c => c.figs.some(f => f.includes('a&#61;b'))) && charts.some(c => c.figs.some(f => f.includes('L&#61;F'))));
    const classes = figs.flatMap(f => [...f.matchAll(/class="([^"]*)"/g)].map(m => m[1]));
    assert('class names: only "crc", none ending label / lbl / val / value / num (the email lifter)',
      classes.every(c => c === 'crc') && !classes.some(c => /(label|lbl|val|value|num)$/.test(c)));
    const coords = figs.flatMap(f => [...f.matchAll(/ (?:d|x|y)="([^"]*)"/g)].flatMap(m => m[1].match(/-?\d+(?:\.\d+)?/g) || []));
    assert('coordinates to one decimal', coords.length > 1000 && coords.every(n => !/\.\d\d/.test(n)), coords.find(n => /\.\d\d/.test(n)));
    assert('svg shape: viewBox, width 100%, role img, an aria-label, sans-serif text, flat colours only',
      figs.every(f => /<svg viewBox="0 0 720 (220|340)" width="100%" role="img" aria-label="[^"]+" font-family="sans-serif"/.test(f)
        && !/gradient|<defs|marker|clip-path|filter=/i.test(f)));
    const sMax = Math.max(...charts.filter(c => c.opts.chart === 's_curve').flatMap(c => c.sd.blocks.flatMap(b => b.charts.map(x => x.points.length))));
    const pathPts = figs.flatMap(f => [...f.matchAll(/<path d="([^"]*)"/g)].map(m => (m[1].match(/[ML]/g) || []).length));
    const bMax = Math.max(...charts.filter(c => c.opts.chart === 'daily_bars').flatMap(c => c.sd.blocks.flatMap(b => b.charts.map(x => x.bars.length))));
    assert(`point caps: a 4-year S-curve has ≤ ${120 + 3} points (${sMax}); bars ≤ 120 (${bMax}); no path holds more than 125 points`,
      sMax <= 123 && sMax > 50 && bMax <= 120 && Math.max(...pathPts) <= 125 && figs.every(f => (f.match(/Z/g) || []).length <= 120));
    const jtdBars = charts.find(c => c.opts.chart === 'daily_bars' && c.preset === 'job_to_date' && c.layout === 'separate').sd.blocks[0].charts[0];
    const yearBars = charts.find(c => c.opts.chart === 'daily_bars' && c.preset === 'custom' && c.layout === 'separate').sd.blocks[0].charts[0];
    const lastBars = charts.find(c => c.opts.chart === 'daily_bars' && c.preset === 'last_30' && c.layout === 'separate').sd.blocks[0].charts[0];
    assert('bars bucket weekly past 60 days and monthly past 120 weeks, and say so',
      lastBars.bucket === 'day' && yearBars.bucket === 'week' && jtdBars.bucket === 'month' && jtdBars.bars.length === 35
        && jtdBars.captions.includes('Bars are monthly totals.') && yearBars.captions.includes('Bars are weekly totals.'), `${jtdBars.bars.length} ${yearBars.bars.length}`);
    const comb = charts.find(c => c.layout === 'combined' && c.opts.chart === 's_curve');
    assert('combined: one chart per job, stacked, each caption naming its job', comb.figs.length === 2
      && comb.figs[0].includes('Evil &lt;script&gt;') && comb.figs[1].includes('Second &lt;b&gt;job&lt;/b&gt;'));
    // Run the real email sanitizer: nothing of the chart is eaten.
    const before = charts[0].html, after = sanit(before);
    const capText = h => [...new JSDOM(h).window.document.querySelectorAll('figure.crc figcaption, figure.crc text')].map(e => e.textContent).join('|');
    assert('the email sanitizer leaves every chart, caption and label intact (its on…= rule finds nothing to eat)',
      capText(before) === capText(after) && (after.match(/<\/figure>/g) || []).length === (before.match(/<\/figure>/g) || []).length
        && charts.every(c => capText(c.html) === capText(sanit(c.html))));

    // Running text with a word starting "on" before an "=" (one, only, once,
    // onsite): the sanitizer's on…= rule must find nothing to eat in it — in
    // the intro, the footer, a note, the title, a job's name and every table
    // cell — so what the customer is sent reads as typed.
    {
      const typed = { intro: 'Phase one = done; phase two starts Monday.', footer: 'Call only = after 3pm', note: 'Phase one = 1,200 SY',
        title: 'Week one = 42', desc: 'Fence w/one = 6ft, topsoil only = 4in', job: 'Lot once=paved' };
      const eq = { projects: [{ id: 'eq', 'project-name': typed.job, status: 'In Progress', bidItems: [
        { id: 'Q1', cost_code: 'Site', sub_code: 'Fence', description: typed.desc, unit: 'LF', quantity: '400', unit_cost: '10', start_date: '2026-10-26', target_date: '2026-11-13' }],
      dailyRows: [row('2026-10-26', 'Site', 'Fence', 60), row('2026-10-27', 'Site', 'Fence', 60)] }] };
      const def = vdef([vsec('notes', { text: typed.note }), vsec('bid_progress', { columns: ['sub_code', 'description', 'installed_to_date'] }),
        vsec('plan_vs_actual', { columns: ['sub_code', 'description', 'installed_to_date', 'plan_status'] })],
      { title: typed.title, header: { intro: typed.intro, footer: typed.footer, showGenerated: true } });
      const built = V.buildReportHtml(def, vmk(def, eq, ['eq']));
      const sent = sanit(built);
      const text = h => new JSDOM(h).window.document.body.textContent.replace(/\s+/g, ' ');
      const missing = Object.entries(typed).filter(([, s]) => !text(sent).includes(s)).map(([k]) => k);
      assert('"one = 1,200", "only = 4in", "w/one = 6ft" and the like reach the customer as typed: the sanitized copy reads exactly as built',
        !missing.length && text(sent) === text(built) && (text(built).match(/Fence w\/one = 6ft, topsoil only = 4in/g) || []).length === 2,
        JSON.stringify({ missing, sent: text(sent).slice(0, 400) }));
      assert('…and the <title> too', new JSDOM(sent).window.document.title === typed.title, new JSDOM(sent).window.document.title);
    }
  }

  section('Customer-safe: every v2 section and column, every division');
  {
    const S = SECRET;
    for (const [div, mkData, ids, secrets] of [
      ['paving', RATES, ['rp', 'rp2'], ['16.67', '13.89', '41.67']],
      ['turf', TURF, ['rt'], ['83.33']],
      ['kiewit', KIEWIT, ['rk'], ['14.03']]]) {
      for (const layout of ['separate', 'combined']) {
        const sections = V.SECTION_ORDER.map(t => vsec(t, { columns: allCols(t) }))
          .concat([vsec('chart', { columns: allCols('chart'), options: { chart: 'daily_bars' } })]);
        const safe = vdef(sections, { layout, dates: { preset: 'this_week' } });
        const intl = vdef(sections, { layout, includeInternal: true, dates: { preset: 'this_week' } });
        const data = mkData();
        data.projects[0].dailyRows.forEach(r => { if (r.employee === 'A') r.employee = S.employee; r.rate = S.rate; });
        const cfgX = divCfg(div);
        const hs = V.buildReportHtml(safe, vmk(safe, data, ids, null, cfgX));
        const hi = V.buildReportHtml(intl, vmk(intl, data, ids, null, cfgX));
        const xs = Object.values(workbook(V.buildXlsx(safe, vmk(safe, data, ids, null, cfgX))).parts).join('\n');
        const xi = Object.values(workbook(V.buildXlsx(intl, vmk(intl, data, ids, null, cfgX))).parts).join('\n');
        const intLabels = new Set(), safeLabels = new Set();
        Object.values(V.CATALOG).forEach(c => c.columns.forEach(x => (x.internal ? intLabels : safeLabels).add(x.label)));
        const internalOnly = [...intLabels].filter(l => !safeLabels.has(l));
        const heads = [...new JSDOM(hs).window.document.querySelectorAll('th, .sum-label, .ji-k')].map(e => e.textContent.trim());
        const planted = secrets.concat([S.employee, S.rate]);
        assert(`${div}/${layout}: the internal build does carry the hours-based rates (the scan is looking for something real)`,
          secrets.every(v => hi.includes(v)) && /crew hours/i.test(hi) && hi.includes('data-cr-internal="1"'), secrets.filter(v => !hi.includes(v)).join());
        assert(`${div}/${layout}: customer-safe HTML has none of them — no hours-based rate, crew, name, wage — and no internal header`,
          !planted.some(v => hs.includes(v)) && !/crew hours|crew-hour|man-hour|avg crew/i.test(hs) && !heads.some(h => internalOnly.includes(h))
            && !/INTERNAL/.test(hs) && !hs.includes('data-cr-internal'), planted.filter(v => hs.includes(v)).concat(heads.filter(h => internalOnly.includes(h))).join());
        assert(`${div}/${layout}: …nor the customer-safe workbook (Chart data and all)`,
          !planted.some(v => xs.includes(v)) && !/Crew hours|Crew-Hour|Man-Hour|Avg Crew|INTERNAL/.test(xs) && /Crew hours/.test(xi),
          planted.filter(v => xs.includes(v)).join());
      }
    }
  }

  section('Branding, PM contact, report contact');
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const d = fixture();
    const brand = { display_name: 'Acme Paving <Co> & "Sons"', logo: { mime: 'image/png', base64: PNG, width: 120, height: 40 },
      phone: '555-0100', email: 'office@acme.test', website: 'https://acme.test', address: '1 Road, Town onload=x', report_footer: 'Licensed & insured' };
    const contacts = { p1: { pm: { name: 'Pat <Manager>', phone: '555-0199', email: 'pat@acme.test' } }, p2: { pm: { name: 'Nobody' } } };
    const def = vdef([vsec('job_info'), vsec('bid_progress')], { title: 'Branded', header: { footer: 'Thanks', contactPhone: '555-0123' } });
    const ctxB = vmk(def, d, ['p1', 'p2'], { branding: brand, contacts, reportContact: { name: 'Sam Sender', phone: '555-0000', email: 'sam@acme.test' } });
    const html = V.buildReportHtml(def, ctxB);
    const doc = new JSDOM(html).window.document;
    const srcs = [...html.matchAll(/src\s*=\s*"([^"]*)"/gi)].map(m => m[1]);
    assert('branded masthead: exactly one data-dw-brand, the company name (escaped) and the division under it',
      doc.querySelectorAll('[data-dw-brand]').length === 1 && doc.querySelector('.mast-co').textContent === 'Acme Paving <Co> & "Sons"'
        && doc.querySelector('.mast-left .mast-sub').textContent === 'Paving Division' && !doc.querySelector('.mast-word')
        && doc.querySelector('.mast-rpt').textContent === 'Branded');
    assert('the logo: one <img class="mast-logo">, its src the PNG data URI, and that is the only src= in the page',
      doc.querySelectorAll('img').length === 1 && srcs.length === 1 && srcs[0] === 'data:image/png;base64,' + PNG
        && doc.querySelector('img.mast-logo').getAttribute('alt') === 'Acme Paving <Co> & "Sons"'
        && /max-height:48px;max-width:220px/.test(doc.querySelector('img.mast-logo').getAttribute('style')));
    const foot = doc.querySelector('.rpt-foot');
    assert('footer: the note, "Questions?" (the report\'s phone over the resolved contact\'s), the company lines, and "Prepared with DataWatch"',
      foot.querySelector('.foot-l').children[0].textContent === 'Thanks'
        && foot.querySelector('.foot-q').textContent === 'Questions? Sam Sender · 555-0123 · sam@acme.test'
        && [...foot.querySelectorAll('.foot-co')].map(e => e.textContent).join('|') === 'Licensed & insured|1 Road, Town onload=x · 555-0100 · https://acme.test'
        && foot.lastElementChild.textContent === 'Prepared with DataWatch' && /onload&#61;x/.test(html) && !/onload=x/.test(html));
    const bands = [...doc.querySelectorAll('.job-band')];
    assert('job band: "Project Manager: name · phone · email" when the job has contact data (escaped); none without',
      bands[0].querySelector('.jb-pm').textContent === 'Project Manager: Pat <Manager> · 555-0199 · pat@acme.test' && !bands[1].querySelector('.jb-pm'));
    const brand2 = { brand: null };
    vm.createContext(brand2); brand2.window = brand2;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'report-branding.js'), 'utf8'), brand2);
    assert('dwBrand leaves the branded report alone too', brand2.dwBrand(html) === html);
    const twoLine = new JSDOM(V.buildReportHtml(def, vmk(def, d, ['p1'], { branding: Object.assign({}, brand, { address: '12 Mill Rd\n  York, PA 17401' }) })))
      .window.document;
    assert('a two-line company address prints on the footer\'s one line as "12 Mill Rd, York, PA 17401", as the Branding panel previews it',
      [...twoLine.querySelectorAll('.foot-co')].some(e => e.textContent === '12 Mill Rd, York, PA 17401 · 555-0100 · https://acme.test'),
      [...twoLine.querySelectorAll('.foot-co')].map(e => e.textContent).join(' | '));
    const noPm = V.buildReportHtml(vdef(def.sections, { header: { showPmContact: false } }), ctxB);
    assert('showPmContact off: no PM line', !/class="jb-pm"/.test(noPm));
    const dw = V.buildReportHtml(vdef(def.sections, { header: { branding: 'datawatch' } }), ctxB);
    assert('"DataWatch only": the DataWatch masthead and no logo, whatever branding is passed',
      /<div class="mast-word">DataWatch<\/div>/.test(dw) && !/<img/.test(dw) && !/class="mast-co"/.test(dw) && /DataWatch — /.test(dw));
    const bads = [
      ['an SVG logo', { mime: 'image/svg+xml', base64: PNG }], ['a gif', { mime: 'image/gif', base64: PNG }],
      ['a quote in the payload', { mime: 'image/png', base64: 'AAAA"onerror="alert(1)' }], ['a bad length', { mime: 'image/png', base64: 'AAAAA' }],
      ['markup of a valid length', { mime: 'image/png', base64: 'AA"><b>A' }], ['a nested data URI', { mime: 'image/png', base64: 'data:image/png;base64,AA' }],
      ['padding in the middle', { mime: 'image/png', base64: 'AA==AAAA' }],
      ['a data: prefix smuggled in', { mime: 'image/png', base64: 'data:text/html,AAAA' }], ['a mime with a payload', { mime: 'image/png;x', base64: PNG }],
      ['no payload', { mime: 'image/jpeg', base64: '' }], ['too big', { mime: 'image/png', base64: 'A'.repeat(400004) }]];
    bads.forEach(([why, logo]) => {
      const h = V.buildReportHtml(def, vmk(def, d, ['p1'], { branding: { display_name: 'Co', logo } }));
      assert(`a logo with ${why} is dropped (the company name stays)`, !/<img/.test(h) && !/src=/.test(h) && /class="mast-co">Co</.test(h));
    });
    const jpg = V.buildReportHtml(def, vmk(def, d, ['p1'], { branding: { logo: { mime: 'IMAGE/JPEG', base64: '/9j/4AAQSkZJRg==' } } }));
    assert('a JPEG logo alone brands the masthead (mime read case-blind); only data:image/png|jpeg ever reaches src',
      /<img class="mast-logo" src="data:image\/jpeg;base64,\/9j\/4AAQSkZJRg==" alt="Company logo"/.test(jpg)
        && [...jpg.matchAll(/src="([^"]*)"/g)].every(m => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(m[1])));
    const onlyBad = V.buildReportHtml(def, vmk(def, d, ['p1'], { branding: { display_name: '  ', logo: { mime: 'image/svg+xml', base64: PNG } } }));
    const plain = V.buildReportHtml(def, vmk(def, d, ['p1']));
    assert('branding with nothing usable, or none at all: the DataWatch masthead and footer, byte for byte as before',
      onlyBad === plain && /<div class="mast-word">DataWatch<\/div><div class="mast-sub">Paving Division<\/div>/.test(plain)
        && /<div class="rpt-foot"><span>Thanks<\/span><span>DataWatch — Branded<\/span><\/div>/.test(
          V.buildReportHtml(vdef(def.sections, { title: 'Branded', header: { footer: 'Thanks' } }), vmk(def, d, ['p1']))));
    const withC = V.buildReportHtml(def, vmk(def, d, ['p1'], { contacts: { p1: { pm: { name: 'Pat', phone: '', email: '' } } } }));
    assert('a PM with no phone or email adds no line (the name alone is on the job card)', !/class="jb-pm"/.test(withC));
    const unb = V.buildReportHtml(def, vmk(def, d, ['p1'], { reportContact: { name: 'Sam' } }));
    assert('unbranded with a report contact: the Questions line, and "DataWatch — <title>" on the right',
      /<span class="foot-q">Questions\? Sam · 555-0123<\/span>/.test(unb) && /<span>DataWatch — Branded<\/span><\/div>/.test(unb));
    const wb = workbook(V.buildXlsx(def, ctxB));
    const rep = Object.values(wb.sheets.Report).map(c => c.v);
    assert('XLSX: the company name on the Report sheet\'s title rows, the PM contact in the job card, the Questions? row',
      rep.includes('Acme Paving <Co> & "Sons" — Paving Division · Prepared with DataWatch') && rep.includes('Project Manager')
        && rep.includes('Pat <Manager> · 555-0199 · pat@acme.test') && rep.includes('Questions?') && rep.includes('Sam Sender · 555-0123 · sam@acme.test')
        && !wb.bad.length && !Object.values(wb.parts).join('').includes(PNG));
    assert('XLSX unbranded keeps "DataWatch — Paving Division"', Object.values(workbook(V.buildXlsx(def, vmk(def, d, ['p1']))).sheets.Report)
      .some(c => c.v === 'DataWatch — Paving Division'));
  }

  section('Signed and half-day formatting');
  {
    const F2 = V.formatCell;
    assert('days: whole or half — 2.5, −3.5, +7 signed, 60, and 0.2 rounds to 0',
      F2(2.5, 'days') === '2.5' && F2(-3.5, 'days', '', true) === '-3.5' && F2(7, 'days', '', true) === '+7' && F2(60, 'days') === '60'
        && F2(0.2, 'days') === '0' && F2(-0.2, 'days') === '0' && F2(1234, 'days') === '1,234' && F2(0, 'days', '', true) === '0');
    const def = vdef([vsec('plan_vs_actual', { columns: ['sub_code', 'qty_variance', 'ahead_days', 'forecast_vs_target'], options: { totals: false } })]);
    const ctx = vmk(def, PV(), ['pv']);
    const html = V.buildReportHtml(def, ctx);
    assert('HTML: + on gains for signed columns (+5.56 qty, +7 days, +1 day), − on losses, half days kept',
      html.includes('<td class="num">+5.56</td>') && html.includes('<td class="num">+7</td>') && html.includes('<td class="num">+1</td>')
        && html.includes('<td class="num">-1.5</td>') && html.includes('<td class="num">-630</td>') && html.includes('<td class="num">-11</td>'));
    const wb = workbook(V.buildXlsx(def, ctx));
    const sh = wb.sheets['Planned vs Actual'];
    const fmtAt = (h, sub) => { const c = findCell(sh, h), s = findCell(sh, 'Sub Code'); const r = +Object.keys(sh).find(k => k.startsWith(s.col) && sh[k].v === sub).replace(/\D+/g, ''); return wb.styles[sh[c.col + r].s]; };
    assert('XLSX: signed number formats — +#,##0.0;-#,##0.0;0 for quantities and half days, +#,##0;-#,##0;0 for whole days',
      fmtAt('Qty vs Plan', 'Topsoil') === '+#,##0.0;-#,##0.0;0' && fmtAt('Days Ahead / Behind', 'Lines') === '+#,##0;-#,##0;0'
        && fmtAt('Days Ahead / Behind', 'Post') === '+#,##0.0;-#,##0.0;0' && fmtAt('Finish vs Target', 'Topsoil') === '+#,##0;-#,##0;0', J([fmtAt('Qty vs Plan', 'Topsoil')]));
    assert('the plan footnote is a note row in the XLSX', Object.values(sh).some(c => /^Planned figures use each bid item's Start and Target dates/.test(c.v || '')));
  }

  section('Big jobs stay fast');
  {
    // 20 jobs × 40 bid items × 2,500 daily rows = 50,000 rows, every section
    // — the v2 ones too: plans of every kind (typed dates, job end, a typed
    // rate), both charts, the division rates with trucking tickets —
    // through paving's own helpers.
    const big = [], bigTrucks = [];
    for (let j = 0; j < 20; j++) {
      const bidItems = [], dailyRows = [];
      for (let i = 0; i < 40; i++) {
        bidItems.push({ id: `b${j}-${i}`, cost_code: `CC${i % 8}`, sub_code: i % 5 === 4 ? '' : `SC${i}`, unit: i % 2 ? 'TON' : 'SY',
          quantity: String(1000 + i), unit_cost: String(10 + i), start_date: i % 7 ? (i % 7 === 2 ? '2026-08-15' : '') : '2026-09-01',
          target_date: i % 7 ? '' : '2026-12-01', planned_rate: i % 7 === 3 ? '25' : '' });
      }
      for (let t = 0; t < 150; t++) {
        bigTrucks.push({ id: `t${j}-${t}`, tr_number: `TR-${j}-${t}`, project_id: `j${j}`, loads: String(1 + (t % 9)),
          date: new Date(Date.UTC(2026, 8, 1 + (t % 60))).toISOString().slice(0, 10), cost_code: `CC${t % 8}`, sub_code: t % 3 ? `SC${t % 40}` : '' });
      }
      for (let r = 0; r < 2500; r++) {
        const i = r % 40, day = 1 + (r % 60);
        const dt = new Date(Date.UTC(2026, 8, day)).toISOString().slice(0, 10);
        dailyRows.push({ id: `r${j}-${r}`, date: dt, cost_code: `CC${i % 8}`, sub_code: `SC${i}`, quantity: String(r % 13),
          labor_hours: '8', rate: '30', employee: `E${r % 17}`, equip_hours: '2', equip_unit_cost: '50' });
      }
      big.push({ id: `j${j}`, 'project-name': `Job ${j}`, 'job-number': String(9000 + j), bidItems, dailyRows, 'contract-value': '100000',
        'end-date': '2026-12-31' });
    }
    env.ctx.projectsList = big;
    const bigData = { projects: big, pos: [], trucks: bigTrucks };
    const def = allColumnsDef(PE, { includeInternal: true });
    def.sections.find(s => s.type === 'daily_production').options.summarize = true;
    def.sections.push(Object.assign(PE.newSection('chart'), { columns: PE.CATALOG.chart.columns.map(c => c.key),
      options: Object.assign(PE.newSection('chart').options, { chart: 'daily_bars' }) }));
    def.sections.push(Object.assign(PE.newSection('plan_vs_actual'), { options: Object.assign(PE.newSection('plan_vs_actual').options, { groupBy: 'cost_code' }) }));
    const ids = big.map(p => p.id);
    const t0 = Date.now();
    const ctx = PE.makeContext(def, cfgFor(env, bigData), { pickedIds: ids, today: TODAY, now: NOW });
    const html = PE.buildReportHtml(def, ctx);
    const t1 = Date.now();
    const xl = PE.buildXlsx(def, ctx);
    const t2 = Date.now();
    const cdef = PE.normalizeDefinition(Object.assign({}, def, { layout: 'combined' }));
    const cctx = PE.makeContext(cdef, cfgFor(env, bigData), { pickedIds: ids, today: TODAY, now: NOW });
    const chtml = PE.buildReportHtml(cdef, cctx);
    const t3 = Date.now();
    PE.buildXlsx(cdef, PE.makeContext(cdef, cfgFor(env, bigData), { pickedIds: ids, today: TODAY, now: NOW }));
    const t4 = Date.now();
    console.log(`    (HTML ${t1 - t0} ms, ${(html.length / 1e6).toFixed(2)} MB; XLSX ${t2 - t1} ms, ${(xl.length / 1e6).toFixed(2)} MB; combined HTML ${t3 - t2} ms; combined XLSX ${t4 - t3} ms)`);
    assert('separate HTML for 50,000 rows in under 4 s', t1 - t0 < 4000, `${t1 - t0} ms`);
    assert('XLSX in under 4 s', t2 - t1 < 4000, `${t2 - t1} ms`);
    assert('combined HTML in under 4 s', t3 - t2 < 4000, `${t3 - t2} ms`);
    assert('combined XLSX in under 4 s', t4 - t3 < 4000, `${t4 - t3} ms`);
    const kinds = new Set(def.sections.map(s => s.type));
    assert('…with every v2 section in it, each drawing something: plans, both charts (40 figures), division rates',
      ['plan_vs_actual', 'chart', 'rate_summary'].every(k => kinds.has(k)) && (html.match(/<figure class="crc">/g) || []).length === 40
        && (chtml.match(/<figure class="crc">/g) || []).length === 40 && /Planned per day/.test(html) && /Bid item start \+ job end/.test(html)
        && /class="sec sec-rate_summary"/.test(html), (html.match(/<figure class="crc">/g) || []).length);
    // Spot-check one figure at scale against the page.
    const bp = PE.buildSectionData(def.sections.find(s => s.type === 'bid_progress'), def, ctx);
    const b = big[7].bidItems[13];
    const row = rowsOf(bp, 7).find(r => r.sub_code === b.sub_code);
    assert('…and the figures still equal the page\'s', near(row.installed_to_date, env.ctx.runningQtyForBidItem(b, 'j7'))
      && near(row.actual_cost, env.ctx.actualForBidItem(b, 'j7')));
    env.ctx.projectsList = d0.projects;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
