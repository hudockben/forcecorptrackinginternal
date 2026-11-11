#!/usr/bin/env node
'use strict';
/**
 * Bid Line Items vs Actuals — the XLSX button.
 *
 * Run: node scripts/test-bid-xlsx.js
 *      BID_XLSX_OUT=dir node scripts/test-bid-xlsx.js   (also writes the books out)
 *
 * The bid page could only leave as a PDF, a picture of the table. The XLSX
 * button hands over the same figures as a workbook: numbers as numbers, dates
 * as dates, Bid Cost Total / Variance / the cost code totals as formulas.
 *
 * Runs each division page's own bid helpers in a vm against one fixture job,
 * builds the workbook through bid-xlsx.js, unzips it the way Excel reads a ZIP
 * and parses every part as XML — one malformed part is enough for Excel to
 * refuse the whole file — then reads the cells back. Also checks the button is
 * in the toolbar, wired, and loads the writer.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}

const ROOT   = path.resolve(__dirname, '..');
const WRITER = fs.readFileSync(path.join(ROOT, 'bid-xlsx.js'), 'utf8');
// Paving quotes the contract through its change-order helpers; the other two
// read the contract fields straight, so a contract CO does not move theirs.
const CO_HELPERS = ['contractCOs', 'contractCOTotal', 'originalContract', 'revisedContract', 'projectContract'];
// Paving alone splits equipment run on a Labor row onto the cost code's
// Equipment line; its actualForBidItem reads the pieces through the first,
// and its projectedCostForProject adds every line up off one walk of the rows
// with the second.
const PAVING_OWN = ['_bidEachCostPiece', '_bidCodeTotals'];
const PAGES  = [
  { file: 'tracker.html',         area: 'SF', costTotal: 'Cost Total',     contract: 9000, extra: [], own: [] },
  { file: 'paving.html',          area: 'SY', costTotal: 'Bid Cost Total', contract: 9500, extra: CO_HELPERS, own: PAVING_OWN },
  { file: 'kiewit-pinetree.html', area: 'SY', costTotal: 'Bid Cost Total', contract: 9000, extra: [], own: [] },
];

// The page's bid figures, lifted rather than restated — a second copy of a
// rule is a second place for it to drift.
const LIFT = ['fmt', 'qfmt', 'actualForBidItem', 'runningQtyForBidItem', 'cumulativeHoursForBidItem',
  'laborerCountForBidItem', '_rowIsWorkDay', '_workDaysForItems', 'daysWorkedForGroup', '_autoBidDates',
  'autoBidDates', '_bidCsKey', 'bidItemComplete', 'bidGroupPct', 'bidProjectPct', '_bidGroupMeasure',
  '_bidGroupUnitCostText', 'projIsDone', 'projForBidItem', 'projectedCostForProject', 'offBidForProject',
  'bidContractFigures', 'generateBidXlsx'];

// Dates long past, so a typed start/target never projects off today's date.
const fixture = () => ({
  id: 'p1', 'project-name': 'Indiana Country Club', 'job-number': '26089', status: 'Active', sqft: '1556',
  'contract-value': '9000', 'contract-cos': [{ amount: '500' }],
  'bid-group-measures': { Milling: { qty: 1556, unit: 'SY' } },
  bidItems: [
    { id: 'b1', cost_code: 'Milling', sub_code: 'Milling - Labor', unit: 'SY', quantity: '1556', unit_cost: '1.11', is_complete: true },
    { id: 'b2', cost_code: 'Milling', sub_code: 'Milling - Trucking', unit: 'HR', quantity: '40', unit_cost: '120',
      change_orders: [{ qty_delta: '8' }], start_date: '2025-10-01' },
    { id: 'b3', cost_code: 'Overlay & <Base> "A"\u000B', sub_code: 'Overlay - Travel', unit: 'HR', quantity: '', unit_cost: '' },
  ],
  dailyRows: [
    { date: '2025-10-05', cost_code: 'Milling', sub_code: 'Milling - Labor', employee: 'Ann', labor_hours: '8', quantity: '1000', total_cost: '1200' },
    { date: '2025-10-06', cost_code: 'Milling', sub_code: 'Milling - Labor', employee: 'Bob', labor_hours: '6', quantity: '556',  total_cost: '816.25' },
    { date: '2025-10-05', cost_code: 'Milling', sub_code: 'Milling - Trucking', employee: 'Cal', labor_hours: '10', quantity: '20', total_cost: '2400' },
    { date: '2025-10-06', cost_code: 'Overlay & <Base> "A"\u000B', sub_code: 'Overlay - Travel', employee: 'Ann', labor_hours: '1', total_cost: '62.5' },
    // Off-bid: a PO delivery booked to no bid line. Counts in the job's
    // actual, matches no line.
    { date: '2025-10-07', cost_code: '', sub_code: '', total_cost: '500' },
  ],
});

// A stored-entry ZIP, read the way Excel reads one: end-of-central-directory,
// central directory, local headers — a wrong offset, size or CRC throws.
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

// sheet XML → { A1: { v, f, s, t } } plus each row's outline level
function readSheet(xml) {
  const doc = xmlDoc(xml);
  const cells = {}, levels = {};
  for (const row of doc.getElementsByTagName('row')) levels[row.getAttribute('r')] = +(row.getAttribute('outlineLevel') || 0);
  for (const c of doc.getElementsByTagName('c')) {
    const f = c.getElementsByTagName('f')[0], v = c.getElementsByTagName('v')[0], t = c.getElementsByTagName('t')[0];
    const type = c.getAttribute('t');
    cells[c.getAttribute('r')] = {
      s: +(c.getAttribute('s') || 0), f: f ? f.textContent : null, t: type,
      v: type === 'inlineStr' ? (t ? t.textContent : '') : type === 'str' ? (v ? v.textContent : '') : v ? +v.textContent : null,
    };
  }
  return { cells, levels };
}

// styles.xml → for each cellXfs index, its number format code and font flags
function readStyles(xml) {
  const doc = xmlDoc(xml);
  const fmts = {};
  for (const n of doc.getElementsByTagName('numFmt')) fmts[n.getAttribute('numFmtId')] = n.getAttribute('formatCode');
  const fonts = [...doc.getElementsByTagName('fonts')[0].getElementsByTagName('font')].map(f => ({
    b: !!f.getElementsByTagName('b').length, i: !!f.getElementsByTagName('i').length,
    color: (f.getElementsByTagName('color')[0] || { getAttribute: () => '' }).getAttribute('rgb'),
  }));
  return [...doc.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf')].map(x => ({
    fmt: fmts[x.getAttribute('numFmtId')] || null, font: fonts[+x.getAttribute('fontId')],
  }));
}

const near = (a, b) => Math.abs(a - b) < 0.005;

async function runPage(page) {
  console.log(`\n${page.file}`);
  const SRC = fs.readFileSync(path.join(ROOT, page.file), 'utf8');

  // ── Markup: the button sits left of Email, is wired, and the writer loads ──
  const doc = new JSDOM(SRC).window.document;
  const btn = doc.getElementById('bid-fs-xlsx');
  assert('toolbar carries an XLSX button', btn && /XLSX/.test(btn.textContent));
  assert('…in the slot left of Email', btn && btn.nextElementSibling && btn.nextElementSibling.id === 'bid-fs-email');
  assert('openBidView opens the cost-code picker in xlsx mode',
    /getElementById\('bid-fs-xlsx'\)\.onclick = \(\) => showBidPDFOptions\(projId, 'xlsx'\)/.test(requireFn(SRC, 'openBidView')));
  const picker = requireFn(SRC, 'showBidPDFOptions');
  assert('the picker\'s xlsx mode runs generateBidXlsx', /mode === 'xlsx'[\s\S]*generateBidXlsx\(\)/.test(picker));
  assert('the page loads bid-xlsx.js', [...doc.querySelectorAll('script[src]')].some(s => s.getAttribute('src') === 'bid-xlsx.js'));

  // ── Behaviour ──
  let proj = fixture();
  let checked = [];
  const calls = [];
  const blobs = new Map();
  const ctx = vm.createContext({
    console, TextEncoder, Blob, setTimeout: () => {}, alert: m => { throw new Error('alert: ' + m); },
    pvPreview: { active: false },
    getProj: id => (proj && proj.id === id ? proj : null),
    getAllDailyRows: () => (proj ? proj.dailyRows : []),
    dailyRowCost: r => parseFloat(r.total_cost) || 0,
    // The size-aware benchmark reads every other job; one figure stands in.
    computeSizeAwarePastAvg: (q, cc, sc) => (sc === 'Milling - Labor' ? { histUC: 1.77 } : null),
    closeBidPDFModal: () => {},
    URL: { createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b); return k; }, revokeObjectURL: () => {} },
    document: {
      querySelectorAll: () => checked.map(value => ({ value })),
      createElement: () => { const a = { href: '', download: '', remove() {} }; a.click = () => calls.push({ name: a.download, blob: blobs.get(a.href) }); return a; },
      body: { appendChild() {} },
    },
  });
  ctx.window = ctx;
  vm.runInContext([
    'let _bidPDFProjId = null;',
    'const _bidCsComplete = {};',
    "const BID_GROUP_UNIT_DEFAULT = 'SY';",
    ...LIFT.concat(page.extra, page.own).map(n => requireFn(SRC, n, page.file)),
  ].join('\n'), ctx);
  vm.runInContext(WRITER, ctx, { filename: 'bid-xlsx.js' });

  let built = 0;
  async function build(codes) {
    checked = codes;
    calls.length = 0;
    vm.runInContext("_bidPDFProjId = 'p1'; generateBidXlsx();", ctx);
    if (calls.length !== 1) throw new Error('expected one download, got ' + calls.length);
    const buf = Buffer.from(await calls[0].blob.arrayBuffer());
    if (process.env.BID_XLSX_OUT) {
      fs.mkdirSync(process.env.BID_XLSX_OUT, { recursive: true });
      fs.writeFileSync(path.join(process.env.BID_XLSX_OUT, `${page.file.replace('.html', '')}-${++built}.xlsx`), buf);
    }
    const parts = unzip(buf);
    const bad = Object.entries(parts).filter(([, x]) => xmlDoc(x).getElementsByTagName('parsererror').length);
    return { name: calls[0].name, parts, bad, sheet: readSheet(parts['xl/worksheets/sheet1.xml']), styles: readStyles(parts['xl/styles.xml']) };
  }

  const ALL = ['Milling', 'Overlay & <Base> "A"\u000B'];
  const wb = await build(ALL);
  const { cells, levels } = wb.sheet;
  const val = ref => (cells[ref] ? cells[ref].v : undefined);

  assert('downloads a .xlsx named for the job', /^bid-items-indiana-country-club-26089-\d{4}-\d{2}-\d{2}\.xlsx$/.test(wb.name), wb.name);
  assert('every part parses as XML', !wb.bad.length, wb.bad.map(([n]) => n).join(', '));
  assert('package has the parts Excel needs',
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']
      .every(n => wb.parts[n]));
  assert('no control characters reach the XML', !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(wb.parts['xl/worksheets/sheet1.xml']));

  // Find the header row rather than assume where the masthead ends.
  const headRow = +Object.keys(cells).find(r => /^A\d+$/.test(r) && cells[r].v === 'Cost Code').slice(1);
  const H = n => headRow + n;
  assert('title names the job', val('A1') === 'Bid Line Items vs Actuals — Indiana Country Club — 26089', val('A1'));
  assert(`header carries the page's own "${page.costTotal}" label and Days Worked`,
    val('J' + headRow) === page.costTotal && val('R' + headRow) === 'Days Worked');
  assert(`cost per ${page.area} line uses the division's unit`,
    Object.values(cells).some(c => typeof c.v === 'string' && c.v.startsWith(`Cost / ${page.area} · 1,556.00 ${page.area.toLowerCase()}`)));
  assert('print titles repeat the header row', wb.parts['xl/workbook.xml'].includes(`'Bid Items'!$${headRow}:$${headRow}`));

  // Milling: band row, two lines, Total row.
  const band = H(1), l1 = H(2), l2 = H(3), sub = H(4);
  assert('green band names the cost code, with its % complete, days and $/unit',
    // 55.1%: Labor (complete, $1,727.16 of bid) at 100, Trucking ($5,760) at
    // 20 of 48 — weighted by bid dollars. $4,416.25 actual ÷ 1,556 SY = $2.84.
    val('A' + band) === 'Milling'
      && val('B' + band) === '55.1% complete · 1/2 sub codes done · 2 days worked · 1,556 SY @ $2.84/SY', val('B' + band));
  assert('a line carries its cost code and sub code in their own columns',
    val('A' + l1) === 'Milling' && val('B' + l1) === 'Milling - Labor' && val('C' + l1) === 'SY');
  assert('quantities, unit cost and actual are plain numbers',
    val('D' + l1) === 1556 && val('E' + l1) === 1556 && val('G' + l1) === 1.11 && near(val('K' + l1), 2016.25)
      && val('L' + l1) === 14 && val('M' + l1) === 2 && val('I' + l1) === 1.77);
  assert('Bid Cost Total is Bid Qty × Unit Cost, as a formula',
    cells['J' + l1].f === `D${l1}*G${l1}` && near(val('J' + l1), 1727.16));
  assert('Variance is Bid Cost Total − Actual, signed, worded under/over by its format',
    cells['N' + l1].f === `J${l1}-K${l1}` && near(val('N' + l1), 1727.16 - 2016.25)
      && /under.*over/.test(wb.styles[cells['N' + l1].s].fmt));
  assert('Qty Completed and Running Unit Cost are formulas off the row',
    cells['F' + l1].f === `IF(D${l1}=0,"",E${l1}/D${l1})` && val('F' + l1) === 1
      && /^IF\(AND\(E\d+>0,K\d+<>0\),K\d+\/E\d+,""\)$/.test(cells['H' + l1].f) && near(val('H' + l1), 2016.25 / 1556));
  assert('a change order counts in Bid Qty, as on screen', val('D' + l2) === 48 && near(val('J' + l2), 5760));
  assert('lines are an outline group under their Total row', levels[l1] === 1 && levels[l2] === 1 && levels[sub] === 0 && levels[band] === 0);
  assert('dates are real dates — typed upright, from the daily sheets in italics',
    val('P' + l2) === 45931 && !wb.styles[cells['P' + l2].s].font.i            // 2025-10-01, typed
      && val('P' + l1) === 45935 && wb.styles[cells['P' + l1].s].font.i         // 2025-10-05, from the sheets
      && /mmm d, yyyy/.test(wb.styles[cells['P' + l1].s].fmt));
  assert('Days Worked per line', val('R' + l1) === 2 && val('R' + l2) === 1);
  assert('cost code Total row SUBTOTALs its own lines',
    val('A' + sub) === 'Milling — Total' && cells['J' + sub].f === `SUBTOTAL(9,J${l1}:J${l2})`
      && near(val('J' + sub), 1727.16 + 5760) && cells['K' + sub].f === `SUBTOTAL(9,K${l1}:K${l2})` && near(val('K' + sub), 4416.25)
      && cells['O' + sub].f === `SUBTOTAL(9,O${l1}:O${l2})` && cells['N' + sub].f === `J${sub}-K${sub}`);

  // Second cost code: a free-text name full of markup, an un-bid line.
  const band2 = H(5), l3 = H(6), sub2 = H(7), tot = H(8);
  assert('a cost code full of XML markup comes through intact', val('A' + band2) === 'Overlay & <Base> "A"', val('A' + band2));
  assert('an un-bid line with spend shows its actual, and Qty Completed stays blank',
    val('D' + l3) === 0 && near(val('K' + l3), 62.5) && val('F' + l3) === '' && near(val('O' + l3), 62.5));

  // Totals: the job as the app reports it — the $500 off-bid delivery counts.
  vm.runInContext('var __grand = { a: (getProj("p1").dailyRows || []).reduce((s, r) => s + dailyRowCost(r), 0), p: projectedCostForProject(getProj("p1")), pct: bidProjectPct("p1") };', ctx);
  const grand = ctx.__grand;
  assert('Totals row is the job\'s figures, off-bid spend included',
    val('A' + tot) === 'Totals' && near(val('K' + tot), 4978.75) && near(val('K' + tot), grand.a) && near(val('O' + tot), grand.p));
  assert('Totals Variance is a formula off its own row', cells['N' + tot].f === `J${tot}-K${tot}`);
  assert('Totals % complete is the project roll-up', near(val('F' + tot), grand.pct.pct / 100));
  assert('a note says why the Totals row runs past the cost code totals',
    Object.values(cells).some(c => typeof c.v === 'string' && /every daily cost including any not booked to a bid line/.test(c.v)));

  // ── Contract and projected profit ──
  const usd = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const profit = page.contract - grand.p;
  const line = Object.values(cells).find(c => typeof c.v === 'string' && c.v.startsWith(page.extra.length ? 'Original Contract' : 'Contract Value'));
  assert('the summary line quotes the contract as the page\'s bar does',
    line && (page.extra.length
      ? line.v.startsWith('Original Contract $9,000.00  ·  Change Orders (1) +$500.00  ·  Revised Contract $9,500.00  ·  Bid Budget')
      : line.v.startsWith('Contract Value $9,000.00  ·  Bid Budget')), line && line.v);
  assert('…and Projected Profit, contract less projected cost, with its percent',
    line && line.v.includes(`Projected Profit ${usd(profit)} (${(profit / page.contract * 100).toFixed(1)}%)  ·  Project Complete`), line && line.v);
  const finAt = label => +(Object.keys(cells).find(r => /^N\d+$/.test(r) && cells[r].v === label) || 'N0').slice(1);
  const kRow = finAt(page.extra.length ? 'Revised Contract' : 'Contract Value');
  const pRow = finAt('Projected Profit'), pctRow = finAt('Projected Profit %');
  assert('under the Totals row, the contract sits in the Projected Cost column',
    kRow > tot && near(val('O' + kRow), page.contract), `row ${kRow}: ${val('O' + kRow)}`);
  if (page.extra.length) {
    const oRow = finAt('Original Contract'), cRow = finAt('Change Orders (1)');
    assert('…as Original, Change Orders and Revised once the job has contract COs',
      oRow === tot + 1 && cRow === tot + 2 && kRow === tot + 3 && val('O' + oRow) === 9000 && val('O' + cRow) === 500
        && cells['O' + kRow].f === `O${oRow}+O${cRow}`);
  } else {
    assert('…as a single Contract Value', kRow === tot + 1);
  }
  assert('Projected Profit is a formula: contract less the Totals row\'s Projected Cost',
    pRow === kRow + 1 && cells['O' + pRow].f === `IF(O${kRow}=0,"",O${kRow}-O${tot})` && near(val('O' + pRow), profit),
    `${cells['O' + pRow] && cells['O' + pRow].f} = ${val('O' + pRow)}`);
  assert('…green when the job makes money, with its percent off the contract',
    wb.styles[cells['O' + pRow].s].font.color === (profit >= 0 ? 'FF166534' : 'FF991B1B') && pctRow === pRow + 1
      && cells['O' + pctRow].f === `IF(O${kRow}=0,"",O${pRow}/O${kRow})` && near(val('O' + pctRow), profit / page.contract)
      && wb.styles[cells['O' + pctRow].s].fmt === '0.0%');
  const BAR = requireFn(SRC, 'renderBidFooter');
  assert('the summary bar and the workbook read the contract from one place',
    page.extra.length ? /projectContract\(p\)/.test(BAR) && /value: projectContract\(p\)/.test(requireFn(SRC, 'bidContractFigures'))
                      : /const contractVal = bidContractFigures\(p\)\.value;/.test(BAR));

  // No contract keyed in: profit is left blank, not the whole job as a loss.
  proj = fixture();
  delete proj['contract-value'];
  delete proj['contract-cos'];
  const none = await build(ALL);
  const nc = none.sheet.cells;
  const nLine = Object.values(nc).find(c => typeof c.v === 'string' && c.v.startsWith('Contract Value'));
  const nP = Object.keys(nc).find(r => /^N\d+$/.test(r) && nc[r].v === 'Projected Profit');
  assert('with no contract, the line reads "—" for contract and profit',
    nLine && nLine.v.startsWith('Contract Value —') && nLine.v.includes('Projected Profit —'), nLine && nLine.v);
  assert('…and the Projected Profit cell stays blank until one is typed in',
    nP && nc['O' + nP.slice(1)].v === '' && /^IF\(O\d+=0,"",/.test(nc['O' + nP.slice(1)].f));
  proj = fixture();

  // Picking one cost code: the other drops out, the totals stay whole-job.
  const one = await build(['Milling']);
  const oc = one.sheet.cells;
  const oneTot = H(5);
  assert('a picked subset leaves the other cost codes out',
    !Object.values(oc).some(c => typeof c.v === 'string' && c.v.startsWith('Overlay')));
  assert('…and says so, while its bottom row stays the whole job',
    oc['A' + oneTot] && oc['A' + oneTot].v === 'Project Totals (All Cost Codes)' && near(oc['K' + oneTot].v, grand.a)
      && Object.values(oc).some(c => typeof c.v === 'string' && /1 of 2 cost codes/.test(c.v)));
}

(async () => {
  for (const page of PAGES) await runPage(page);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
