#!/usr/bin/env node
'use strict';
/**
 * Intercompany → Reports → Job Summary — Download Excel
 *
 * Run: node scripts/test-job-summary-xlsx.js
 *
 * The report could only leave the page as a PDF, which is a picture of the
 * table: nothing in it can be sorted, filtered or added to. The Excel export
 * hands over the same figures as a workbook that can be worked in — numbers
 * as numbers, dates as dates, Total Amount and the totals as formulas.
 *
 * Runs the page's own runJobSummaryReport in a vm against stubbed endpoints,
 * clicks the export, unzips what it downloaded and reads the cells back.
 * Every part is also parsed as XML, since one malformed part is enough for
 * Excel to refuse the whole file.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { requireFn, sliceSource } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../intercompany.html'), 'utf8');
const lift = name => requireFn(SRC, name, 'intercompany.html');

const START = '2026-09-16', END = '2026-09-30';

const projects = [
  { id: 'p1', 'project-name': 'Franklin Regional Softball', 'job-number': '26049' },
  { id: 'p2', 'project-name': 'Orchard Hills',              'job-number': '26091' },
  { id: 'p3', 'project-name': '119 Shop Time' },
  { id: 'p4', 'project-name': 'Forest Hills <Gaga> & "Pits"', 'job-number': '02611' },
];

const turfRows = [
  { id: 't1', _projectId: 'p1', date: '2026-09-20', job_class: 'Truck Driver',
    rate: '0', labor_hours: '8', equipment: 'Triaxle Dump', equip_unit_cost: '121', equip_hours: '8' },
  { id: 't2', _projectId: 'p1', date: '2026-09-22', job_class: 'Laborer',
    rate: '25', labor_hours: '8', equipment: 'Toro Triplex', equip_unit_cost: '40', equip_hours: '5' },
  { id: 't3', _projectId: 'p3', date: '2026-09-22', job_class: 'Laborer',
    rate: '36', labor_hours: '15', equipment: '', equip_unit_cost: '0', equip_hours: '0' },
  { id: 't4', _projectId: 'p4', date: '2026-09-28', job_class: 'Operator',
    rate: '43.75', labor_hours: '4.5', equipment: 'Skid Steer', equip_unit_cost: '51.6667', equip_hours: '4.5' },
];
const turfTrucking = [
  { id: 'tr1', project_id: 'p1', date: '2026-09-24', truck_type: 'Lowboy 4', rate: '140', hours: '3' },
];
const pavingRows = [
  { id: 'v1', _projectId: 'p2', date: '2026-09-25', job_class: 'CDL Driver',
    rate: '30', labor_hours: '10', equipment: 'Tri-Axle 12', equip_unit_cost: '110', equip_hours: '10' },
];
// Infill production with no job — the report's standalone infill row.
const inventory = [
  { id: 'i1', date: '2026-09-18', hours: '6', rate: '20', equip_unit_cost: '15', equip_hours: '2' },
];

const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
function fetchStub(url) {
  const u = String(url);
  if (u.startsWith('/api/projects'))           return ok({ projects });
  if (u.startsWith('/api/data/fct_projects'))  return ok({ value: [] });
  if (u.startsWith('/api/data/fct_inventory')) return ok({ value: inventory });
  if (u.startsWith('/api/data/_batch'))        return ok({ values: {} });
  if (u.startsWith('/api/daily-rows')) {
    if (u.includes('division=paving')) return ok({ rows: pavingRows });
    if (u.includes('division=kiewit')) return ok({ rows: [] });
    return ok({ rows: turfRows });
  }
  if (u.startsWith('/api/trucking')) {
    if (u.includes('division=paving')) return ok({ truckingEntries: [] });
    if (u.includes('division=kiewit')) return ok({ truckingEntries: [] });
    return ok({ truckingEntries: turfTrucking });
  }
  throw new Error('unexpected fetch ' + u);
}

const el = () => ({ value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
const els = {
  jsStartDate: el(), jsEndDate: el(), jsSummaryBody: el(), jsReportInfo: el(),
  jsPdfBtn: el(), jsXlsxBtn: el(),
};
els.jsStartDate.value = START;
els.jsEndDate.value   = END;
els.jsXlsxBtn.style.display = 'none';

const downloads = [];
const blobs = new Map();
const ctx = vm.createContext({
  API_BASE: '/api',
  token: 'test',
  fetch: fetchStub,
  console,
  TextEncoder,
  Blob,
  setTimeout: () => {},
  URL: {
    createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b); return k; },
    revokeObjectURL: () => {},
  },
  document: {
    getElementById: id => els[id] || null,
    querySelector:  () => el(),
    createElement:  () => {
      const a = { href: '', download: '', remove() {} };
      a.click = () => downloads.push({ name: a.download, blob: blobs.get(a.href) });
      return a;
    },
    body: { appendChild() {} },
  },
});
vm.runInContext([
  "const fmt$ = v => '$' + v.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');",
  'let _jsHasRun = false;',
  'let _jsReport = null;',
  lift('escT'),
  lift('jsTruckColumn'),
  lift('jsAddMachineCost'),
  'async ' + lift('runJobSummaryReport'),
  // The workbook writer — constants and functions together, as one region.
  sliceSource(SRC, 'const JSX_CRC =', 'function downloadJobSummaryXlsx(',
    'the Job Summary workbook writer', 'function buildJobSummaryXlsx('),
  lift('downloadJobSummaryXlsx'),
].join('\n'), ctx);

// A stored-entry ZIP, read back: name → text.
function unzip(buf) {
  const out = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size   = buf.readUInt32LE(at + 18);
    const nlen   = buf.readUInt16LE(at + 26);
    const xlen   = buf.readUInt16LE(at + 28);
    const name   = buf.slice(at + 30, at + 30 + nlen).toString('utf8');
    if (method !== 0) throw new Error(`${name}: expected a stored entry, got method ${method}`);
    const dataAt = at + 30 + nlen + xlen;
    out[name] = buf.slice(dataAt, dataAt + size).toString('utf8');
    at = dataAt + size;
  }
  return out;
}

// sheet XML → { A1: { v, f, s, t } }
function cells(xml) {
  const doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  const out = {};
  for (const c of doc.getElementsByTagName('c')) {
    const f = c.getElementsByTagName('f')[0];
    const v = c.getElementsByTagName('v')[0];
    const t = c.getElementsByTagName('t')[0];
    out[c.getAttribute('r')] = {
      t: c.getAttribute('t'),
      s: c.getAttribute('s'),
      f: f ? f.textContent : null,
      v: c.getAttribute('t') === 'inlineStr' ? (t ? t.textContent : '') : (v ? Number(v.textContent) : null),
    };
  }
  return out;
}

const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  console.log('\n[button — shown only with a report on screen]');
  assert('hidden before the report has run', els.jsXlsxBtn.style.display === 'none');
  ctx.downloadJobSummaryXlsx();
  assert('clicking with no report downloads nothing', downloads.length === 0);

  await ctx.runJobSummaryReport();
  assert('the report rendered', els.jsSummaryBody.innerHTML.includes('<table'));
  assert('shown once it has', els.jsXlsxBtn.style.display === '');

  // Editing the date boxes without re-running must not relabel the export.
  els.jsStartDate.value = '2026-01-01';
  ctx.downloadJobSummaryXlsx();
  assert('one file downloaded', downloads.length === 1);
  const d = downloads[0];
  assert('named for the window the report was built with',
    d.name === `job-summary-${START}_to_${END}.xlsx`, d.name);

  console.log('\n[package — every part is there and parses]');
  const parts = unzip(Buffer.from(await d.blob.arrayBuffer()));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                      'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
                      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert(`${name} is present`, name in parts);
  }
  for (const [name, xml] of Object.entries(parts)) {
    let okXml = true, why = '';
    try {
      const doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
      if (doc.getElementsByTagName('parsererror').length) { okXml = false; why = 'parsererror'; }
    } catch (e) { okXml = false; why = e.message; }
    assert(`${name} is well-formed XML`, okXml, why);
  }
  assert('two sheets: Job Summary and By Division',
    /<sheet name="Job Summary"[^>]*\/><sheet name="By Division"/.test(parts['xl/workbook.xml']));
  assert('Excel recalculates the formulas on open', /fullCalcOnLoad="1"/.test(parts['xl/workbook.xml']));

  console.log('\n[Job Summary sheet — the rows as numbers]');
  const s1 = cells(parts['xl/worksheets/sheet1.xml']);
  assert('the title row', s1.A1 && s1.A1.v === 'Job Summary Report');
  assert('the window under it', s1.A2 && s1.A2.v.startsWith(`${START} – ${END}`), s1.A2 && s1.A2.v);
  const HEAD = ['Division', 'Project', 'Job #', 'First Date', 'Last Date', 'Labor Costs', 'Equipment Costs',
                'Lowboy Costs', 'Tri Axle Costs', 'Total Amount', 'Hours Worked'];
  assert('the header row', HEAD.every((h, i) => s1[String.fromCharCode(65 + i) + '4'].v === h));

  // Order: Turf jobs by name, infill at the foot of Turf, then Paving.
  const names = [5, 6, 7, 8, 9].map(r => s1['B' + r] && s1['B' + r].v);
  assert('rows in the order the table shows them', JSON.stringify(names) === JSON.stringify([
    '119 Shop Time', 'Forest Hills <Gaga> & "Pits"', 'Franklin Regional Softball',
    'Rubber Infill Production', 'Orchard Hills',
  ]), JSON.stringify(names));
  assert('…with their division in a column of its own',
    [5, 6, 7, 8].every(r => s1['A' + r].v === 'Turf') && s1.A9.v === 'Paving');
  assert('the totals row follows the last job', s1.A10 && s1.A10.v === 'TOTALS' && s1.B10.v == null);
  assert('nothing below the totals', !Object.keys(s1).some(r => +r.replace(/^[A-Z]+/, '') > 10));

  const fr = 7;
  assert('Job # kept as text, not a number', s1['C' + fr].t === 'inlineStr' && s1['C' + fr].v === '26049');
  assert('a leading zero survives', s1.C6.v === '02611', s1.C6.v);
  assert('a job with no number leaves Job # empty', !s1.C5 || s1.C5.v === '' || s1.C5.v == null);
  // 2026-09-20 → 46285, 2026-09-24 → 46289 (days since 1899-12-30).
  assert('First Date is a real date', s1['D' + fr].v === 46285 && s1['D' + fr].s === '6', JSON.stringify(s1['D' + fr]));
  assert('Last Date is a real date',  s1['E' + fr].v === 46289, JSON.stringify(s1['E' + fr]));
  assert('Labor is a number', s1['F' + fr].v === 200 && s1['F' + fr].t == null);
  assert('Equipment is a number', s1['G' + fr].v === 200);
  assert('Lowboy is a number', s1['H' + fr].v === 420);
  assert('Tri Axle is a number', s1['I' + fr].v === 968);
  assert('Total Amount is a formula over the four costs',
    s1['J' + fr].f === `SUM(F${fr}:I${fr})` && s1['J' + fr].v === 1788, JSON.stringify(s1['J' + fr]));
  assert('Hours is a number', s1['K' + fr].v === 16);
  assert('a zero truck cost is a 0 that sums, not a dash', s1.H5.v === 0 && s1.I5.v === 0);

  // Full precision, not rounded to the cent — so the sums land where the
  // on-screen totals do. 4.5 × 51.6667 = 232.50015.
  assert('figures kept at full precision', near(s1.G6.v, 232.50015) && s1.G6.v !== 232.5, s1.G6.v);

  assert('the infill row carries its own costs',
    s1.F8.v === 120 && s1.G8.v === 30 && s1.K8.v === 6 && s1.J8.v === 150, JSON.stringify([s1.F8, s1.G8, s1.J8]));
  assert('Paving row', s1.F9.v === 300 && s1.I9.v === 1100 && s1.J9.v === 1400);

  console.log('\n[Job Summary sheet — totals follow a filter]');
  const tot = c => s1[c + '10'];
  for (const c of ['F', 'G', 'H', 'I', 'J', 'K']) {
    assert(`${c} totals with SUBTOTAL(109) over the jobs`, tot(c).f === `SUBTOTAL(109,${c}5:${c}9)`, tot(c).f);
  }
  const want = col => [5, 6, 7, 8, 9].reduce((a, r) => a + s1[col + r].v, 0);
  for (const c of ['F', 'G', 'H', 'I', 'J', 'K']) {
    assert(`${c} total's cached value is the column's sum`, near(tot(c).v, want(c)), `${tot(c).v} vs ${want(c)}`);
  }
  // The same grand total the table's footer shows.
  const foot = (els.jsSummaryBody.innerHTML.match(/<tfoot>[\s\S]*<\/tfoot>/) || [''])[0];
  const footCells = [...foot.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  const fmt = v => '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  assert('grand total matches the on-screen footer', fmt(tot('J').v) === footCells[6], `${fmt(tot('J').v)} vs ${footCells[6]}`);
  assert('hours total matches the on-screen footer', tot('K').v.toFixed(1) + ' hrs' === footCells[7]);

  const x1 = parts['xl/worksheets/sheet1.xml'];
  assert('filter covers header and jobs, stops above the totals', x1.includes('<autoFilter ref="A4:K9"/>'));
  assert('header row frozen', /<pane ySplit="4" topLeftCell="A5"[^>]*state="frozen"\/>/.test(x1));
  assert('Job # "number stored as text" flag suppressed',
    x1.includes('<ignoredError sqref="C5:C9" numberStoredAsText="1"/>'));
  assert('header repeats on every printed page',
    parts['xl/workbook.xml'].includes(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Job Summary'!$4:$4</definedName>`));
  assert('names are escaped, not raw markup', x1.includes('Forest Hills &lt;Gaga&gt; &amp; &quot;Pits&quot;'));

  console.log('\n[By Division sheet — the subtotal rows, as formulas]');
  const s2 = cells(parts['xl/worksheets/sheet2.xml']);
  assert('Turf, then Paving', s2.A5.v === 'Turf' && s2.A6.v === 'Paving' && s2.A7.v === 'TOTALS');
  assert('Turf project count leaves infill out',
    s2.B5.v === 3 && s2.B5.f.includes('"<>Rubber Infill Production"'), JSON.stringify(s2.B5));
  assert('Turf labor is a SUMIF over the first sheet',
    s2.C5.f === "SUMIF('Job Summary'!$A$5:$A$9,$A5,'Job Summary'!$F$5:$F$9)", s2.C5.f);
  assert('Turf total includes infill, as the subtotal row does',
    near(s2.G5.v, s1.J5.v + s1.J6.v + s1.J7.v + s1.J8.v), s2.G5.v);
  assert('Paving total', s2.G6.v === 1400);
  assert('the divisions add up to the grand total', near(s2.G7.v, tot('J').v) && s2.G7.f === 'SUM(G5:G6)');
  assert('project count total', s2.B7.v === 4);

  console.log('\n[one division — no By Division sheet]');
  pavingRows.length = 0;
  inventory.length = 0;
  await ctx.runJobSummaryReport();
  ctx.downloadJobSummaryXlsx();
  const one = unzip(Buffer.from(await downloads[1].blob.arrayBuffer()));
  assert('a single sheet', !('xl/worksheets/sheet2.xml' in one) && !/By Division/.test(one['xl/workbook.xml']));

  console.log('\n[a failed run takes the export away]');
  ctx.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  await ctx.runJobSummaryReport();
  assert('button hidden', els.jsXlsxBtn.style.display === 'none');
  ctx.downloadJobSummaryXlsx();
  assert('and clicking it anyway downloads nothing', downloads.length === 2);

  console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
