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
const zlib = require('zlib');
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
  // Markup characters, and the vertical tab a Word Shift+Enter pastes as —
  // XML 1.0 has no way to carry it, and Excel refuses the file over one.
  { id: 'p4', 'project-name': 'Forest Hills <Gaga> & "Pits"\u000B', 'job-number': '02611' },
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

// Holds back every request for one window until released, so a test can make
// a run land after a later one — the order preset chips can produce.
let gate = null;
function holdWindow(since) {
  let release;
  gate = { since, wait: new Promise(r => { release = r; }) };
  return () => { gate = null; release(); };
}

const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
function fetchStub(url) {
  const u = String(url);
  if (gate && u.includes('since=' + gate.since)) {
    const g = gate;
    return g.wait.then(() => fetchStub(url));
  }
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

// The button as the page's markup declares it — read, not assumed, so a
// renamed id, a lost display:none or a misspelt handler fails here.
const PAGE = new JSDOM(SRC).window.document;
const markupBtn = PAGE.getElementById('jsXlsxBtn');

const el = () => ({ value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
const els = {
  jsStartDate: el(), jsEndDate: el(), jsSummaryBody: el(), jsReportInfo: el(),
  jsPdfBtn: el(), jsXlsxBtn: el(),
};
els.jsStartDate.value = START;
els.jsEndDate.value   = END;
els.jsXlsxBtn.style.display = markupBtn ? markupBtn.style.display : '';

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
  lift('jsClearExport'),
  'async ' + lift('runJobSummaryReport'),
  // The workbook writer — constants and functions together, as one region.
  sliceSource(SRC, 'const JSX_CRC =', 'function downloadJobSummaryXlsx(',
    'the Job Summary workbook writer', 'function buildJobSummaryXlsx('),
  lift('downloadJobSummaryXlsx'),
].join('\n'), ctx);

// A stored-entry ZIP, read back the way Excel reads one: from the end-of-
// central-directory record, through the central directory, to each local
// header — so a wrong offset, size or CRC anywhere in the container throws
// here instead of passing on parts a real reader would never find.
function unzip(buf) {
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no end-of-central-directory record');
  const count  = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdAt   = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error('EOCD entry counts disagree');
  if (cdAt + cdSize !== eocd) throw new Error(`central directory at ${cdAt}+${cdSize} does not end at the EOCD (${eocd})`);

  const out = {};
  let at = cdAt;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} has a bad signature`);
    const crc    = buf.readUInt32LE(at + 16);
    const size   = buf.readUInt32LE(at + 20);
    const nlen   = buf.readUInt16LE(at + 28);
    const local  = buf.readUInt32LE(at + 42);
    const name   = buf.slice(at + 46, at + 46 + nlen).toString('utf8');
    at += 46 + nlen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: central directory points at no local header`);
    if (buf.readUInt16LE(local + 8) !== 0) throw new Error(`${name}: expected a stored entry`);
    if (buf.readUInt32LE(local + 14) !== crc || buf.readUInt32LE(local + 18) !== size
        || buf.slice(local + 30, local + 30 + nlen).toString('utf8') !== name) {
      throw new Error(`${name}: local header disagrees with the central directory`);
    }
    const dataAt = local + 30 + nlen + buf.readUInt16LE(local + 28);
    const data = buf.slice(dataAt, dataAt + size);
    if (zlib.crc32(data) !== crc) throw new Error(`${name}: CRC-32 does not match its data`);
    out[name] = data.toString('utf8');
  }
  if (at !== eocd) throw new Error('central directory has trailing bytes');
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
  console.log('\n[button — the markup]');
  assert('the page has a #jsXlsxBtn', !!markupBtn);
  if (markupBtn) {
    assert('it starts hidden', markupBtn.style.display === 'none', markupBtn.getAttribute('style'));
    assert('it calls downloadJobSummaryXlsx()', markupBtn.getAttribute('onclick') === 'downloadJobSummaryXlsx()',
      markupBtn.getAttribute('onclick'));
    assert('it sits in the Job Summary toolbar, beside Download PDF',
      !!markupBtn.closest('#rpt-job-summary .rpt-toolbar')
      && markupBtn.previousElementSibling && markupBtn.previousElementSibling.id === 'jsPdfBtn');
  }
  assert('the handler is a function the page defines', /\bfunction downloadJobSummaryXlsx\(/.test(SRC));

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
  assert('control characters are stripped', !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(x1)
    && s1.B6.v === 'Forest Hills <Gaga> & "Pits"', JSON.stringify(s1.B6.v));
  // Excel needs only the autoFilter element; LibreOffice also needs this
  // hidden name, or it opens the sheet with no filter dropdowns.
  assert('the filter range is named, so LibreOffice keeps the dropdowns', parts['xl/workbook.xml'].includes(
    `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Job Summary'!$A$4:$K$9</definedName>`));

  console.log('\n[By Division sheet — the subtotal rows, as formulas]');
  const s2 = cells(parts['xl/worksheets/sheet2.xml']);
  assert('Turf, then Paving', s2.A5.v === 'Turf' && s2.A6.v === 'Paving' && s2.A7.v === 'TOTALS');
  assert('Turf project count leaves infill out', s2.B5.v === 3, JSON.stringify(s2.B5));
  // Not a formula keyed on the infill row's name — a job can carry any name.
  assert('…as a plain count, not a formula on project names', s2.B5.f == null && s2.B6.f == null);
  assert('Turf labor is a SUMIF over the first sheet',
    s2.C5.f === "SUMIF('Job Summary'!$A$5:$A$9,$A5,'Job Summary'!$F$5:$F$9)", s2.C5.f);
  assert('Turf total includes infill, as the subtotal row does',
    near(s2.G5.v, s1.J5.v + s1.J6.v + s1.J7.v + s1.J8.v), s2.G5.v);
  assert('Paving total', s2.G6.v === 1400);
  assert('the divisions add up to the grand total', near(s2.G7.v, tot('J').v) && s2.G7.f === 'SUM(G5:G6)');
  assert('project count total', s2.B7.v === 4);

  console.log('\n[a job named like the infill row still counts as a job]');
  const named = ctx.buildJobSummaryXlsx({
    startDate: START, endDate: END, projects: 2, entries: 3, infillEntries: 1,
    divisions: [{ key: 'turf', label: 'Turf' }, { key: 'paving', label: 'Paving' }],
    rows: [
      { divLabel: 'Turf', division: 'turf', name: 'Rubber Infill Production', jobNo: '26111',
        minDate: START, maxDate: END, laborCost: 10, equipCost: 0, lowboyCost: 0, triAxleCost: 0, total: 10, hoursWorked: 1 },
      { divLabel: 'Turf', division: 'turf', name: 'Rubber Infill Production', jobNo: '', infill: true,
        minDate: START, maxDate: END, laborCost: 5, equipCost: 0, lowboyCost: 0, triAxleCost: 0, total: 5, hoursWorked: 1 },
      { divLabel: 'Paving', division: 'paving', name: 'Lot', jobNo: '1',
        minDate: START, maxDate: END, laborCost: 1, equipCost: 0, lowboyCost: 0, triAxleCost: 0, total: 1, hoursWorked: 1 },
    ],
  });
  const nb = cells(unzip(Buffer.from(await named.arrayBuffer()))['xl/worksheets/sheet2.xml']);
  assert('Turf counts the job and not the infill row', nb.B5.v === 1 && nb.B5.f == null, JSON.stringify(nb.B5));

  console.log('\n[a bad date range takes the export away]');
  els.jsStartDate.value = START;
  els.jsEndDate.value   = END;
  await ctx.runJobSummaryReport();
  assert('a report is on screen again', els.jsXlsxBtn.style.display === '');
  els.jsEndDate.value = '2026-09-01';
  await ctx.runJobSummaryReport();
  assert('Invalid Range is showing', els.jsSummaryBody.innerHTML.includes('Invalid Range'));
  assert('…and the button is hidden', els.jsXlsxBtn.style.display === 'none');
  assert('…and so is Download PDF', els.jsPdfBtn.style.display === 'none');
  const before = downloads.length;
  ctx.downloadJobSummaryXlsx();
  assert('…and clicking it anyway downloads nothing', downloads.length === before);

  els.jsEndDate.value = END;
  await ctx.runJobSummaryReport();
  els.jsStartDate.value = '';
  await ctx.runJobSummaryReport();
  assert('Date Range Required hides it too',
    els.jsSummaryBody.innerHTML.includes('Date Range Required') && els.jsXlsxBtn.style.display === 'none');

  console.log('\n[No Data takes the export away — even landing after a later run]');
  // A slow run for an empty window, started first, landing after a faster
  // one has put its table up. The start-of-run reset has already happened
  // for both by then, so only No Data itself can clear the export.
  els.jsStartDate.value = '2025-01-01';
  els.jsEndDate.value   = '2025-01-31';
  const release = holdWindow('2025-01-01');
  const slow = ctx.runJobSummaryReport();
  els.jsStartDate.value = START;
  els.jsEndDate.value   = END;
  await ctx.runJobSummaryReport();
  assert('the later run put its table up', els.jsXlsxBtn.style.display === ''
    && els.jsSummaryBody.innerHTML.includes('<table'));
  release();
  await slow;
  assert('the earlier run landed last, with No Data', els.jsSummaryBody.innerHTML.includes('No Data'));
  assert('…and the button is hidden', els.jsXlsxBtn.style.display === 'none');
  const beforeNoData = downloads.length;
  ctx.downloadJobSummaryXlsx();
  assert('…and clicking it anyway downloads nothing', downloads.length === beforeNoData);

  console.log('\n[one division — no By Division sheet]');
  els.jsStartDate.value = START;
  els.jsEndDate.value   = END;
  pavingRows.length = 0;
  inventory.length = 0;
  await ctx.runJobSummaryReport();
  ctx.downloadJobSummaryXlsx();
  const one = unzip(Buffer.from(await downloads[downloads.length - 1].blob.arrayBuffer()));
  assert('a single sheet', !('xl/worksheets/sheet2.xml' in one) && !/By Division/.test(one['xl/workbook.xml']));

  console.log('\n[a failed run takes the export away]');
  ctx.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  await ctx.runJobSummaryReport();
  assert('button hidden', els.jsXlsxBtn.style.display === 'none');
  const afterFail = downloads.length;
  ctx.downloadJobSummaryXlsx();
  assert('and clicking it anyway downloads nothing', downloads.length === afterFail);

  console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
