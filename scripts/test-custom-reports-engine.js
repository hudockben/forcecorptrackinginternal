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
  '_localDateStr', '_usHolidays', '_isHoliday', '_addWorkingDays', '_poTotals'];
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
    'formatCell', 'escHtml'];
  assert('window.FCTReportEngine exposes every member of the contract', API.every(k => k in E), API.filter(k => !(k in E)).join(', '));
  assert('VERSION is 1', E.VERSION === 1);
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
  assert('ten section types, in the + Add section order',
    allTypes.length === 10 && E.SECTION_ORDER.length === 10 && E.SECTION_ORDER.every(t => E.CATALOG[t]));
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
      if (!['select', 'bool', 'costCodes', 'kinds'].includes(o.kind) || !o.label) colProblems.push(`${t}.${o.key}: spec`);
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
  assert('defaultDefinition is a blank v1: no sections, jobs picked at run time, customer-safe',
    blank.v === 1 && blank.sections.length === 0 && blank.jobs.mode === 'pick' && blank.jobs.ids.length === 0
      && blank.includeInternal === false && blank.layout === 'separate' && blank.dates.preset === 'job_to_date'
      && blank.header.showGenerated === true);
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
  assert('junk in: v1 out, includeInternal only when literally true', junk.v === 1 && junk.includeInternal === false
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

  assert('seven starter templates, each already normalized',
    E.STARTERS.length === 7 && E.STARTERS.every(s => s.id && s.name && s.blurb
      && JSON.stringify(E.normalizeDefinition(s.definition)) === JSON.stringify(s.definition)));
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
  assert('escHtml escapes & < > " \'', E.escHtml(`<a href="x">'&'</a>`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');

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
      assert(`${layout}: a job named <img onerror> prints as text`, html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'));
      assert(`${layout}: no element reaches the page from user text`,
        doc.querySelectorAll('img, script, iframe, b, i, u').length === 0 && doc.querySelectorAll('h1').length === 1,
        [...doc.querySelectorAll('img, script, b, i, u')].map(e => e.outerHTML).join(' '));
      assert(`${layout}: title, labels, cost codes, notes and header fields all escaped`,
        doc.title === '</title><script>alert("t")</script>' && html.includes('&lt;b&gt;CC&lt;/b&gt;') && html.includes('O&#39;Brien &amp; Sons')
          && html.includes('&lt;img src=y&gt;') && html.includes('&lt;i&gt;you&lt;/i&gt;') && html.includes('&lt;u&gt;f&lt;/u&gt;'));
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
    assert('a Report sheet first, then one per table section', wb.names[0] === 'Report' && wb.names.length === 1 + tableCount, wb.names.join(' | '));
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

  section('Big jobs stay fast');
  {
    // 20 jobs × 40 bid items × 2,500 daily rows = 50,000 rows, every section,
    // through paving's own helpers.
    const big = [];
    for (let j = 0; j < 20; j++) {
      const bidItems = [], dailyRows = [];
      for (let i = 0; i < 40; i++) {
        bidItems.push({ id: `b${j}-${i}`, cost_code: `CC${i % 8}`, sub_code: i % 5 === 4 ? '' : `SC${i}`, unit: i % 2 ? 'TON' : 'SY',
          quantity: String(1000 + i), unit_cost: String(10 + i), start_date: i % 7 ? '' : '2026-09-01', target_date: i % 7 ? '' : '2026-12-01' });
      }
      for (let r = 0; r < 2500; r++) {
        const i = r % 40, day = 1 + (r % 60);
        const dt = new Date(Date.UTC(2026, 8, day)).toISOString().slice(0, 10);
        dailyRows.push({ id: `r${j}-${r}`, date: dt, cost_code: `CC${i % 8}`, sub_code: `SC${i}`, quantity: String(r % 13),
          labor_hours: '8', rate: '30', employee: `E${r % 17}`, equip_hours: '2', equip_unit_cost: '50' });
      }
      big.push({ id: `j${j}`, 'project-name': `Job ${j}`, 'job-number': String(9000 + j), bidItems, dailyRows, 'contract-value': '100000' });
    }
    env.ctx.projectsList = big;
    const bigData = { projects: big, pos: [], trucks: [] };
    const def = allColumnsDef(PE, { includeInternal: true });
    def.sections.find(s => s.type === 'daily_production').options.summarize = true;
    const ids = big.map(p => p.id);
    const t0 = Date.now();
    const ctx = PE.makeContext(def, cfgFor(env, bigData), { pickedIds: ids, today: TODAY, now: NOW });
    const html = PE.buildReportHtml(def, ctx);
    const t1 = Date.now();
    const xl = PE.buildXlsx(def, ctx);
    const t2 = Date.now();
    const cdef = PE.normalizeDefinition(Object.assign({}, def, { layout: 'combined' }));
    PE.buildReportHtml(cdef, PE.makeContext(cdef, cfgFor(env, bigData), { pickedIds: ids, today: TODAY, now: NOW }));
    const t3 = Date.now();
    console.log(`    (HTML ${t1 - t0} ms, ${(html.length / 1e6).toFixed(2)} MB; XLSX ${t2 - t1} ms, ${(xl.length / 1e6).toFixed(2)} MB; combined HTML ${t3 - t2} ms)`);
    assert('separate HTML for 50,000 rows in under 4 s', t1 - t0 < 4000, `${t1 - t0} ms`);
    assert('XLSX in under 4 s', t2 - t1 < 4000, `${t2 - t1} ms`);
    assert('combined HTML in under 4 s', t3 - t2 < 4000, `${t3 - t2} ms`);
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
