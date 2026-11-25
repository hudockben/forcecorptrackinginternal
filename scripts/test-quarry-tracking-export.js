#!/usr/bin/env node
'use strict';
/**
 * Quarry ▸ Daily, Crushing and Sales Tracking — the ⇩ Download button
 * (Excel / CSV).
 *
 * Run: node scripts/test-quarry-tracking-export.js
 *      TRACKING_EXPORT_OUT=dir node scripts/test-quarry-tracking-export.js   (also writes the files out)
 *
 * Loads quarry.html in jsdom with stubbed blob endpoints, narrows each table
 * with its own filters, presses Download for each format and reads the file
 * back:
 *
 *   - each file carries exactly the rows the table RENDERED, in its order —
 *     checked against the DOM, including after a cell edit the table does not
 *     re-render for
 *   - the .xlsx unzips the way Excel reads a ZIP and every part parses as XML —
 *     one malformed part is enough for Excel to refuse the whole file — with
 *     dates as date serials, numbers as numbers, each row's arithmetic as
 *     formulas (cached values matching the screen) and a SUBTOTAL Totals row
 *     whose rate columns are weighted averages
 *   - Crushing's Cost / Ton is the DAY's blend, as the table shows it, even
 *     with a Product filter hiding some of the day; its Days sheet is the
 *     table's day header lines
 *   - the .csv's headers are the Bulk Upload template's, and the page's own
 *     importer reads it straight back
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT          = path.resolve(__dirname, '..');
const HTML_PATH     = path.join(ROOT, 'quarry.html');
const BRANDING_PATH = path.join(ROOT, 'report-branding.js');
const OUT_DIR       = process.env.TRACKING_EXPORT_OUT;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const near = (a, b) => a != null && Math.abs(Number(a) - Number(b)) < 1e-6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const serial = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
const isoOf = n => new Date((Number(n) - 25569) * 86400000).toISOString().slice(0, 10);
// A Cost / Ton cell as the sheet shows it: the text "—", or a dollar figure.
const cptShown = v => v === '—' ? '—' : money(Number(v));
const COLS = n => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));

// ── Fixture ────────────────────────────────────────────────────────────────
const LISTS = {
  location: [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:  [{ id: 'p1', name: '6-' }, { id: 'p2', name: '2B' }, { id: 'p3', name: '1B Limestone' }, { id: 'p4', name: '2A Modified' }],
  customer: [
    { id: 'c1', name: 'Force Turf Solutions', taxable: false },
    { id: 'c2', name: 'Kunkle Excavating',    taxable: true, taxRate: '6' },
    { id: 'c3', name: 'CASH "TAXABLE" <A&B>, Inc', taxable: true, taxRate: '6.35' },
  ],
  equipment: [{ id: 'q1', name: 'Loader 980' }, { id: 'q2', name: 'Excavator 336' }],
  tasks:     [{ id: 't1', name: 'Loading' }, { id: 't2', name: 'Stripping' }],
  employees: [{ id: 'e1', name: 'Jaimie Boring' }, { id: 'e2', name: 'Nick Detwiler' }, { id: 'e3', name: 'Ann Crew' }],
};

const SALES = [
  { id: 's1', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'Force Turf Solutions', productName: '6-',           tons: 21.88, payment: 'Credit', pricePerTon: 12.75 },
  { id: 's2', date: '2026-11-20', locationName: 'Homer City', employeeName: 'Nick Detwiler', customerName: 'Force Turf Solutions', productName: '6-',           tons: 22.35, payment: 'Credit', pricePerTon: 12.75 },
  { id: 's3', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'Kunkle Excavating',    productName: '2B',           tons: 3.02,  payment: 'Credit', pricePerTon: 14.5 },
  // Submitted on the Quarry Sales form — read-only on screen, still exported.
  { id: 'qss-41-row', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'CASH "TAXABLE" <A&B>, Inc', productName: '1B Limestone', tons: 4.16, payment: 'Cash', pricePerTon: 27 },
  { id: 's5', date: '2026-11-18', locationName: 'McGees Mills', employeeName: 'Nick Detwiler', customerName: 'Kunkle Excavating', productName: '2B', tons: 10, payment: 'Cash', pricePerTon: 15 },
  { id: 's6', date: '2025-06-01', locationName: 'Homer City', employeeName: 'Nick Detwiler', customerName: 'Kunkle Excavating', productName: '2B', tons: 5, payment: 'Cash', pricePerTon: 13 },
  // A row nobody has finished: no tons, no price. Exports as blanks, not NaN.
  { id: 's7', date: '2026-11-21', locationName: 'Homer City', employeeName: '', customerName: 'Kunkle Excavating', productName: '2B', tons: '', payment: '', pricePerTon: '' },
];
const SALES_IDS = ['s7', 's2', 's1', 's3', 'qss-41-row'];   // 2026 · Homer City, newest first

const DAILY = [
  { id: 'd1', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', equipmentName: 'Loader 980',    taskName: 'Loading',   hours: 8,   rate: 26,    fuelGallons: 30, ppg: 3.459 },
  { id: 'd2', date: '2026-11-20', locationName: 'Homer City', employeeName: 'Nick Detwiler', equipmentName: 'Excavator 336', taskName: 'Stripping', hours: 9.5, rate: 28.5,  fuelGallons: '', ppg: '' },
  // Payroll-owned (approved timesheet) — read-only on screen, still exported.
  { id: 'tsq-77-a', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Ann Crew', equipmentName: '', taskName: 'Loading', hours: 6, rate: 22, fuelGallons: '', ppg: '' },
  { id: 'd4', date: '2026-11-18', locationName: 'McGees Mills', employeeName: 'Nick Detwiler', equipmentName: 'Loader 980', taskName: 'Loading', hours: 4, rate: 28.5, fuelGallons: 10, ppg: 3.5 },
  { id: 'd5', date: '2025-03-02', locationName: 'Homer City', employeeName: 'Nick Detwiler', equipmentName: 'Loader 980', taskName: 'Loading', hours: 3, rate: 28.5, fuelGallons: 5, ppg: 3.2 },
  // Fuel only — no hours (required on import), so the round trip flags it.
  { id: 'd6', date: '2026-11-21', locationName: 'Homer City', employeeName: 'Nick Detwiler', equipmentName: 'Loader 980', taskName: '', hours: '', rate: '', fuelGallons: 40, ppg: 3.399 },
];
const DAILY_IDS = ['d6', 'd2', 'd1', 'tsq-77-a'];   // 2026 · Homer City, newest first

// 8/27 at Homer City, the day the crushing comments are written about: the
// operator's row carries the loads, the crew's rows carry only their hours.
// Whole day: payroll 8×30 + 8×25 + 8×25 + 6×22 = 772; fuel 120×3.5 = 420;
// tons 30×27 = 810 → $1,192 ÷ 810 = $1.4716…/ton. The operator's row alone
// would read $240 ÷ 810 = $0.30 — the number the day blend exists to stop.
const CRUSH = [
  { id: 'k1', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Jaimie Boring', productName: '2A Modified', hourlyRate: 30, hours: 8, fuelGallons: '', fuelCost: '', loadsToCrusher: 30, tonsPerLoad: 27, hoursCrushing: 7.5, comments: 'Ran the jaw, "fines" heavy, screen 2\nswapped at noon' },
  { id: 'k2', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Nick Detwiler', productName: '', hourlyRate: 25, hours: 8, fuelGallons: '', fuelCost: '', loadsToCrusher: '', tonsPerLoad: '', hoursCrushing: '', comments: '' },
  { id: 'k3', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Ann Crew',      productName: '', hourlyRate: 25, hours: 8, fuelGallons: 120, fuelCost: 3.5, loadsToCrusher: '', tonsPerLoad: '', hoursCrushing: '', comments: 'fuel for the day' },
  { id: 'tsq-90-c', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Ann Crew', productName: '', hourlyRate: 22, hours: 6, fuelGallons: '', fuelCost: '', loadsToCrusher: '', tonsPerLoad: '', hoursCrushing: '', comments: '' },
  // Same date, other pit: its own day, never blended with Homer City's.
  { id: 'k5', date: '2026-08-27', locationName: 'McGees Mills', employeeName: 'Nick Detwiler', productName: '2A Modified', hourlyRate: 28, hours: 5, fuelGallons: 20, fuelCost: 3.4, loadsToCrusher: 10, tonsPerLoad: 25, hoursCrushing: 4, comments: '' },
  // A day that crushed nothing: no cost per ton, "—" on screen.
  { id: 'k6', date: '2026-08-28', locationName: 'Homer City', employeeName: 'Nick Detwiler', productName: '', hourlyRate: 25, hours: 4, fuelGallons: '', fuelCost: '', loadsToCrusher: '', tonsPerLoad: '', hoursCrushing: '', comments: 'teardown _x0041_ \uFFFE end' },
  // Tons and no cost recorded: $0.00 a ton on screen — not "—", which means no tons.
  { id: 'k8', date: '2026-08-29', locationName: 'McGees Mills', employeeName: 'Nick Detwiler', productName: '', hourlyRate: '', hours: '', fuelGallons: '', fuelCost: '', loadsToCrusher: 4, tonsPerLoad: 25, hoursCrushing: 2, comments: '' },
  { id: 'k7', date: '2025-08-27', locationName: 'Homer City', employeeName: 'Nick Detwiler', productName: '2A Modified', hourlyRate: 25, hours: 4, fuelGallons: '', fuelCost: '', loadsToCrusher: 5, tonsPerLoad: 20, hoursCrushing: 2, comments: '' },
];
const HOMER_DAY = { payroll: 772, fuel: 420, tons: 810, cost: 1192 };

const BLOBS = {
  fct_quarry_lists: LISTS, fct_quarry_sales: SALES, fct_quarry_crushing: CRUSH, fct_quarry_daily: DAILY,
  fct_quarry_inventory: {}, fct_quarry_loss_pct: {}, fct_presence: {},
};

// ── Harness ────────────────────────────────────────────────────────────────
function stubFetch(blobs) {
  return async (url, init) => {
    const m = /\/api\/data\/([^?]+)/.exec(String(url));
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ value: Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
}

function loadPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.eval(fs.readFileSync(BRANDING_PATH, 'utf8'));
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', name: 'Test User', companyCode: 'TEST', companyName: 'Test Co',
      }));
      win.fetch = stubFetch(BLOBS);
      win.alert = (msg) => { (win.__alerts = win.__alerts || []).push(String(msg)); };
      win.print = () => {};
      // jsdom has no object URLs — catch the Blob and the name it was saved under.
      win.__saved = [];
      win.URL.createObjectURL = (blob) => { win.__saved.push({ blob }); return 'blob:test/' + win.__saved.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () {
        const last = win.__saved[win.__saved.length - 1];
        if (last) last.name = this.download;
      };
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
}

// Stored-ZIP reader (the writer never compresses).
function unzipStored(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const size   = buf.readUInt32LE(p + 20);
    const nlen   = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local  = buf.readUInt32LE(p + 42);
    const name   = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (method !== 0) throw new Error(`${name}: compressed entry`);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    out[name] = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + size).toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
async function blobBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
  return Buffer.from(await blob.text());
}

// Press Download → <kind> on a tab, the way a person does, and hand back the file.
async function download(win, tab, kind) {
  const doc = win.document;
  const btn = doc.getElementById(tab + 'ExportBtn');
  btn.click();
  const opt = doc.querySelector(`#${tab}ExportMenu .export-opt[onclick="downloadTrackingExport('${tab}', '${kind}')"]`);
  if (!opt) throw new Error(`no ${kind} option on ${tab}`);
  opt.click();
  assert(`${tab}: choosing ${kind} closes the menu`, doc.querySelector(`#${tab}ExportMenu .ms-menu`).hidden);
  const saved = win.__saved.shift();
  if (!saved) throw new Error(`${tab} ${kind}: nothing saved`);
  saved.buf = await blobBuffer(saved.blob);
  if (OUT_DIR) { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, saved.name), saved.buf); }
  return saved;
}

// Unzip, parse every part, and index each sheet's cells by reference.
function readBook(win, label, buf) {
  const parts = unzipStored(buf);
  const parser = new win.DOMParser();
  let allParse = true;
  for (const [name, xml] of Object.entries(parts)) {
    const d = parser.parseFromString(xml, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) { allParse = false; console.error(`    ${name} does not parse`); }
  }
  assert(`${label}: every package part parses as XML`, allParse);
  assert(`${label}: no NaN / Infinity in any part`, !Object.values(parts).some(x => /NaN|Infinity/.test(x)));
  const sheets = [];
  for (let i = 1; parts[`xl/worksheets/sheet${i}.xml`]; i++) {
    const doc = parser.parseFromString(parts[`xl/worksheets/sheet${i}.xml`], 'application/xml');
    const cells = {};
    for (const c of doc.getElementsByTagName('c')) {
      const f = c.getElementsByTagName('f')[0], v = c.getElementsByTagName('v')[0], t = c.getElementsByTagName('t')[0];
      cells[c.getAttribute('r')] = { f: f ? f.textContent : null, v: v ? v.textContent : (t ? t.textContent : null) };
    }
    const sv = doc.getElementsByTagName('sheetView')[0];
    sheets.push({
      doc, cells,
      val: ref => (cells[ref] || {}).v,
      fml: ref => (cells[ref] || {}).f,
      selected: sv.getAttribute('tabSelected') === '1',
      filter: (doc.getElementsByTagName('autoFilter')[0] || { getAttribute: () => null }).getAttribute('ref'),
      ySplit: (doc.getElementsByTagName('pane')[0] || { getAttribute: () => null }).getAttribute('ySplit'),
    });
  }
  const names = [...parser.parseFromString(parts['xl/workbook.xml'], 'application/xml').getElementsByTagName('sheet')].map(s => s.getAttribute('name'));
  return { parts, sheets, names };
}

// The rendered table, as text: each data row's cells, inputs read by value.
function domRows(doc, tbodyId, pick) {
  const cellText = el => { const i = el.querySelector('input'); return i ? i.value : el.textContent.trim(); };
  return [...doc.querySelectorAll(`#${tbodyId} tr`)]
    .filter(tr => !tr.classList.contains('crush-day') && !tr.querySelector('.sales-empty'))
    .map(tr => pick.map(i => cellText(tr.children[i])));
}

function csvLines(text) {
  return text.replace(/^﻿/, '');
}
function templateHeader(win, tab) {
  return win.eval(`BULK_CONFIGS.${tab}.templateLayout.map(it => typeof it === 'string'
      ? BULK_CONFIGS.${tab}.fields.find(f => f.name === it).label : it.label)`);
}

async function main() {
  const dom = loadPage();
  const win = dom.window, doc = win.document;
  for (let i = 0; i < 80 && !win.eval('typeof listsLoaded !== "undefined" && listsLoaded'); i++) await sleep(25);
  for (const tab of ['sales', 'crushing', 'daily']) win.switchTab(tab);
  for (let i = 0; i < 120 && !win.eval('salesLoaded && crushLoaded && dailyLoaded'); i++) await sleep(25);
  await sleep(50);
  eq('no uncaught script errors on load', win.__errors, []);

  // ── Toolbar, on every tab ──
  console.log('\n— Toolbar —');
  for (const [tab, panel] of [['daily', 'tab-daily'], ['crushing', 'tab-crushing'], ['sales', 'tab-sales']]) {
    const btn = doc.getElementById(tab + 'ExportBtn');
    assert(`${tab}: Download sits in its own toolbar`, !!btn && !!btn.closest(`#${panel} .sales-toolbar`));
    assert(`${tab}: enabled once its rows load`, btn && !btn.disabled);
    eq(`${tab}: two choices, Excel and CSV`,
      [...doc.querySelectorAll(`#${tab}ExportMenu .export-opt`)].map(b => b.getAttribute('onclick')),
      [`downloadTrackingExport('${tab}', 'xlsx')`, `downloadTrackingExport('${tab}', 'csv')`]);
  }
  {
    const btn = doc.getElementById('dailyExportBtn');
    const menu = doc.querySelector('#dailyExportMenu .ms-menu');
    assert('menu starts closed', menu.hidden);
    btn.click();
    assert('clicking Download opens it', !menu.hidden && btn.getAttribute('aria-expanded') === 'true');
    doc.body.click();
    assert('a click elsewhere closes it', menu.hidden && btn.getAttribute('aria-expanded') === 'false');
    btn.click();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert('Escape closes it', menu.hidden);
    // One menu open at a time, across tabs and the filter dropdowns.
    btn.click();
    doc.getElementById('crushingExportBtn').click();
    assert('opening another tab\'s Download closes this one',
      menu.hidden && !doc.querySelector('#crushingExportMenu .ms-menu').hidden);
    doc.querySelector('#crushingLocationFilter .ms-toggle').click();
    assert('opening a filter dropdown closes Download', doc.querySelector('#crushingExportMenu .ms-menu').hidden);
    doc.body.click();
  }

  // ══ Sales ══════════════════════════════════════════════════════════════════
  console.log('\n— Sales · Excel —');
  win.setYearFilter('sales', '2026');
  win.eval("msSet('location', 'sales').add('Homer City'); msApply('sales', 'location');");
  eq('sales: table shows the filtered rows, newest first', win.eval('salesShown.map(e => e.row.id)'), SALES_IDS);
  const salesSummary = doc.getElementById('salesSummary').textContent;
  {
    const xl = await download(win, 'sales', 'xlsx');
    assert('sales: file name carries the year, "-filtered" and today', /^quarry-sales-2026-filtered-\d{4}-\d{2}-\d{2}\.xlsx$/.test(xl.name), xl.name);
    eq('sales: xlsx MIME', xl.blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const book = readBook(win, 'sales', xl.buf);
    eq('sales: one sheet, "Sales"', book.names, ['Sales']);
    const { val, fml } = book.sheets[0];
    eq('sales: the file is the rendered table, row for row',
      SALES_IDS.map((_, i) => [isoOf(val('A' + (6 + i))), val('D' + (6 + i)), val('F' + (6 + i)) == null ? '' : String(Number(val('F' + (6 + i))))]),
      domRows(doc, 'salesTbody', [0, 3, 5]));
    eq('sales: title', val('A1'), 'Sales Tracking — Test Co');
    eq('sales: filter line', val('A2'), 'Filters: 2026 · all months · Homer City · all customers · all products');
    assert('sales: count line', /^5 rows · exported .* by tester$/.test(val('A3')), val('A3'));
    eq('sales: header', COLS(13).map(c => val(c + '5')),
      ['Date','Location','Employee','Customer','Product','Tons','Payment','Price / Ton','Tax Rate','Sales Tax','Net Sales','Total Due','Source']);
    const R = id => 6 + SALES_IDS.indexOf(id);
    eq('sales: dates are Excel date serials', SALES_IDS.map(id => Number(val('A' + R(id)))), SALES_IDS.map(id => serial(SALES.find(s => s.id === id).date)));
    const r1 = R('s1');
    eq('sales: Net Sales / Sales Tax / Total Due are formulas', [fml('K' + r1), fml('J' + r1), fml('L' + r1)], [`F${r1}*H${r1}`, `K${r1}*I${r1}`, `K${r1}+J${r1}`]);
    assert('sales: Net Sales cached', near(val('K' + r1), 21.88 * 12.75));
    const r3 = R('s3');
    assert('sales: 6% customer taxed', near(val('I' + r3), 0.06) && near(val('J' + r3), 3.02 * 14.5 * 0.06));
    const q = R('qss-41-row');
    eq('sales: XML-hostile name survives', val('D' + q), 'CASH "TAXABLE" <A&B>, Inc');
    eq('sales: form-submitted sale marked', val('M' + q), 'Quarry Sales form');
    eq('sales: unfinished row is blank, not NaN', [val('F' + R('s7')), val('H' + R('s7'))], [null, null]);
    const T = 6 + SALES_IDS.length;
    eq('sales: Totals are SUBTOTALs', ['F','J','K','L'].map(c => fml(c + T)), ['F','J','K','L'].map(c => `SUBTOTAL(9,${c}6:${c}${T - 1})`));
    const vis = SALES.filter(s => SALES_IDS.includes(s.id));
    const rate = { 'Kunkle Excavating': 0.06, 'CASH "TAXABLE" <A&B>, Inc': 0.0635 };
    const tons = vis.reduce((n, s) => n + (Number(s.tons) || 0), 0);
    const net  = vis.reduce((n, s) => n + (Number(s.tons) || 0) * (Number(s.pricePerTon) || 0), 0);
    const tax  = vis.reduce((n, s) => n + (Number(s.tons) || 0) * (Number(s.pricePerTon) || 0) * (rate[s.customerName] || 0), 0);
    assert('sales: Totals tons / net / tax / due', near(val('F' + T), tons) && near(val('K' + T), net) && near(val('J' + T), tax) && near(val('L' + T), net + tax));
    eq('sales: Totals Price / Ton is the weighted average', fml('H' + T), `IF(F${T}=0,0,K${T}/F${T})`);
    assert('sales: Totals match the summary bar', salesSummary.includes(money(net)) && salesSummary.includes(money(net + tax)), salesSummary);
    eq('sales: AutoFilter is header + data', book.sheets[0].filter, `A5:M${T - 1}`);
    eq('sales: header frozen', book.sheets[0].ySplit, '5');
    const hr = [...book.sheets[0].doc.getElementsByTagName('row')].find(r => r.getAttribute('r') === '5');
    eq('sales: header row is two lines tall', [hr.getAttribute('ht'), hr.getAttribute('customHeight')], ['30', '1']);
    assert('sales: header cells wrap', /wrapText="1"/.test(book.parts['xl/styles.xml']));
    assert('sales: header repeats on printed pages', /_xlnm\.Print_Titles[^>]*>'Sales'!\$5:\$5</.test(book.parts['xl/workbook.xml']));
  }
  console.log('\n— Sales · CSV —');
  {
    const cv = await download(win, 'sales', 'csv');
    assert('sales: csv name', /^quarry-sales-2026-filtered-\d{4}-\d{2}-\d{2}\.csv$/.test(cv.name), cv.name);
    const text = cv.buf.toString('utf8');
    assert('sales: UTF-8 BOM', text.charCodeAt(0) === 0xFEFF);
    const lines = csvLines(text).split('\r\n').filter(Boolean);
    eq('sales: header is the Bulk Upload template\'s, then Source', lines[0], templateHeader(win, 'sales').concat('Source').join(','));
    eq('sales: one line per row on screen', lines.length - 1, SALES_IDS.length);
    eq('sales: s1', lines[1 + SALES_IDS.indexOf('s1')], '2026-11-19,Homer City,Jaimie Boring,Force Turf Solutions,6-,21.88,Credit,12.75,0.00,278.97,278.97,Sales Tracking');
    eq('sales: quoted name, form-submitted', lines[1 + SALES_IDS.indexOf('qss-41-row')], '2026-11-19,Homer City,Jaimie Boring,"CASH ""TAXABLE"" <A&B>, Inc",1B Limestone,4.16,Cash,27,7.13,112.32,119.45,Quarry Sales form');
    win.__csv = text;
    win.eval("parseBulk('sales', window.__csv)");
    const parsed = win.eval('bulkParsed.sales.parsed');
    eq('sales: importer reads every complete row back clean (the unfinished one lacks required tons/price)',
      parsed.filter(p => p.errors.length).map(p => p.rowNum), [2 + SALES_IDS.indexOf('s7')]);
    assert('sales: …and skips them as duplicates of rows already here', parsed.filter(p => !p.errors.length).every(p => p.duplicate));
  }

  // ══ Daily ══════════════════════════════════════════════════════════════════
  console.log('\n— Daily · Excel —');
  win.switchTab('daily');
  await sleep(30);
  win.setYearFilter('daily', '2026');
  win.eval("msSet('location', 'daily').add('Homer City'); msApply('daily', 'location');");
  eq('daily: table shows the filtered rows, newest first', win.eval('dailyShown.map(e => e.row.id)'), DAILY_IDS);
  const dailySummary = doc.getElementById('dailySummary').textContent;
  {
    const xl = await download(win, 'daily', 'xlsx');
    assert('daily: file name', /^quarry-daily-2026-filtered-\d{4}-\d{2}-\d{2}\.xlsx$/.test(xl.name), xl.name);
    const book = readBook(win, 'daily', xl.buf);
    eq('daily: one sheet, "Daily"', book.names, ['Daily']);
    const { val, fml } = book.sheets[0];
    eq('daily: the file is the rendered table, row for row',
      DAILY_IDS.map((_, i) => { const r = 6 + i; return [isoOf(val('A' + r)), val('C' + r) || '', val('F' + r) == null ? '' : String(Number(val('F' + r)))]; }),
      domRows(doc, 'dailyTbody', [0, 2, 5]));
    eq('daily: title', val('A1'), 'Daily Tracking — Test Co');
    eq('daily: filter line', val('A2'), 'Filters: 2026 · all months · Homer City');
    eq('daily: header', COLS(13).map(c => val(c + '5')),
      ['Date','Location','Employee','Equipment','Task','Hours','Rate','Labor Cost','Fuel / Gallons','PPG','Fuel Cost','Total Cost','Source']);
    const R = id => 6 + DAILY_IDS.indexOf(id);
    const r1 = R('d1');
    eq('daily: d1 inputs', ['B','C','D','E'].map(c => val(c + r1)).concat([F => Number(val('F' + r1)), () => Number(val('G' + r1)), () => Number(val('I' + r1)), () => Number(val('J' + r1))].map(f => f())),
      ['Homer City', 'Jaimie Boring', 'Loader 980', 'Loading', 8, 26, 30, 3.459]);
    eq('daily: Labor / Fuel / Total are formulas', [fml('H' + r1), fml('K' + r1), fml('L' + r1)], [`F${r1}*G${r1}`, `I${r1}*J${r1}`, `H${r1}+K${r1}`]);
    assert('daily: d1 cached values', near(val('H' + r1), 208) && near(val('K' + r1), 30 * 3.459) && near(val('L' + r1), 208 + 30 * 3.459));
    eq('daily: no fuel → blank inputs, not NaN', [val('I' + R('d2')), val('J' + R('d2'))], [null, null]);
    eq('daily: timesheet row marked', val('M' + R('tsq-77-a')), 'Payroll timesheet');
    eq('daily: own row marked', val('M' + r1), 'Daily Tracking');
    const T = 6 + DAILY_IDS.length;
    eq('daily: Totals are SUBTOTALs', ['F','H','I','K','L'].map(c => fml(c + T)), ['F','H','I','K','L'].map(c => `SUBTOTAL(9,${c}6:${c}${T - 1})`));
    const vis = DAILY.filter(d => DAILY_IDS.includes(d.id));
    const hours = vis.reduce((n, d) => n + (Number(d.hours) || 0), 0);
    const labor = vis.reduce((n, d) => n + (Number(d.hours) || 0) * (Number(d.rate) || 0), 0);
    const gal   = vis.reduce((n, d) => n + (Number(d.fuelGallons) || 0), 0);
    const fuel  = vis.reduce((n, d) => n + (Number(d.fuelGallons) || 0) * (Number(d.ppg) || 0), 0);
    assert('daily: Totals hours / labor / gallons / fuel / total', near(val('F' + T), hours) && near(val('H' + T), labor) && near(val('I' + T), gal) && near(val('K' + T), fuel) && near(val('L' + T), labor + fuel));
    eq('daily: Totals Rate is labor ÷ hours, PPG fuel ÷ gallons', [fml('G' + T), fml('J' + T)], [`IF(F${T}=0,0,H${T}/F${T})`, `IF(I${T}=0,0,K${T}/I${T})`]);
    assert('daily: weighted averages cached', near(val('G' + T), labor / hours) && near(val('J' + T), fuel / gal));
    assert('daily: Totals match the summary bar', dailySummary.includes(money(labor + fuel)), dailySummary);
    eq('daily: AutoFilter is header + data', book.sheets[0].filter, `A5:M${T - 1}`);
  }
  console.log('\n— Daily · CSV —');
  {
    const cv = await download(win, 'daily', 'csv');
    assert('daily: csv name', /^quarry-daily-2026-filtered-\d{4}-\d{2}-\d{2}\.csv$/.test(cv.name), cv.name);
    const text = cv.buf.toString('utf8');
    const lines = csvLines(text).split('\r\n').filter(Boolean);
    eq('daily: header is the Bulk Upload template\'s, then Source', lines[0], templateHeader(win, 'daily').concat('Source').join(','));
    eq('daily: one line per row on screen', lines.length - 1, DAILY_IDS.length);
    eq('daily: d1', lines[1 + DAILY_IDS.indexOf('d1')], '2026-11-19,Homer City,Jaimie Boring,Loader 980,Loading,8,26,208.00,30,3.459,103.77,311.77,Daily Tracking');
    eq('daily: d2 (no fuel)', lines[1 + DAILY_IDS.indexOf('d2')], '2026-11-20,Homer City,Nick Detwiler,Excavator 336,Stripping,9.5,28.5,270.75,,,0.00,270.75,Daily Tracking');
    eq('daily: timesheet row says so', lines[1 + DAILY_IDS.indexOf('tsq-77-a')].split(',').pop(), 'Payroll timesheet');
    win.__csv = text;
    win.eval("parseBulk('daily', window.__csv)");
    const parsed = win.eval('bulkParsed.daily.parsed');
    eq('daily: importer reads every row back clean but the fuel-only one (hours are required)',
      parsed.filter(p => p.errors.length).map(p => p.rowNum), [2 + DAILY_IDS.indexOf('d6')]);
    assert('daily: …and skips the clean ones as duplicates', parsed.filter(p => !p.errors.length).every(p => p.duplicate));
  }

  // ══ Crushing ═══════════════════════════════════════════════════════════════
  console.log('\n— Crushing · Excel (whole days) —');
  win.switchTab('crushing');
  await sleep(30);
  win.setYearFilter('crushing', '2026');
  const CRUSH_IDS = win.eval('crushShown.map(e => e.row.id)');
  // Newest first; a date's pits in name order, each day's rows in stored order.
  eq('crushing: table order', CRUSH_IDS, ['k8', 'k6', 'k1', 'k2', 'k3', 'tsq-90-c', 'k5']);
  {
    const xl = await download(win, 'crushing', 'xlsx');
    assert('crushing: file name (year only → not "-filtered")', /^quarry-crushing-2026-\d{4}-\d{2}-\d{2}\.xlsx$/.test(xl.name), xl.name);
    const book = readBook(win, 'crushing', xl.buf);
    eq('crushing: two sheets, Entries then Days', book.names, ['Entries', 'Days']);
    eq('crushing: only the first opens selected (two selected sheets open grouped)', book.sheets.map(s => s.selected), [true, false]);
    const E = book.sheets[0], D = book.sheets[1];
    // Entries: three lines under the title, so the header is row 6.
    eq('crushing: header', COLS(19).map(c => E.val(c + '6')),
      ['Date','Location','Employee','Product','Hourly Rate','Hours','Total Payroll','Fuel Gallons','$/Gal','Fuel Cost',
       'Loads to Crusher','Tons / Load','Estimated Tons','Hours Crushing','Tons / Hour','Total Cost','Day Cost / Ton','Source','Comments']);
    const R = id => 7 + CRUSH_IDS.indexOf(id);
    // The DOM's entry rows: date, employee, and the day-blend Cost / Ton text.
    eq('crushing: the file is the rendered table, row for row',
      CRUSH_IDS.map(id => { const r = R(id); return [isoOf(E.val('A' + r)), E.val('C' + r) || '', cptShown(E.val('Q' + r))]; }),
      domRows(doc, 'crushTbody', [0, 2, 16]));
    const r1 = R('k1');
    eq('crushing: row arithmetic is formulas',
      ['G','J','M','O','P'].map(c => E.fml(c + r1)),
      [`E${r1}*F${r1}`, `H${r1}*I${r1}`, `K${r1}*L${r1}`, `IF(N${r1}>0,M${r1}/N${r1},0)`, `G${r1}+J${r1}`]);
    assert('crushing: k1 cached — payroll 240, tons 810, 108 t/hr', near(E.val('G' + r1), 240) && near(E.val('M' + r1), 810) && near(E.val('O' + r1), 108));
    const dayCpt = HOMER_DAY.cost / HOMER_DAY.tons;
    eq('crushing: every row of the 8/27 Homer City day shows the DAY\'s cost per ton, not its own',
      ['k1', 'k2', 'k3', 'tsq-90-c'].map(id => near(E.val('Q' + R(id)), dayCpt)), [true, true, true, true]);
    assert('crushing: …which is not the operator row\'s own $0.30', !near(E.val('Q' + r1), 240 / 810));
    assert('crushing: McGees Mills, same date, is its own day', near(E.val('Q' + R('k5')), (5 * 28 + 20 * 3.4) / 250));
    eq('crushing: a day with no tons has no cost per ton — "—", as the table shows', E.val('Q' + R('k6')), '—');
    eq('crushing: a day with tons and no cost is $0.00 a ton, a number', Number(E.val('Q' + R('k8'))), 0);
    eq('crushing: …shown as $0.00 (the table\'s), not the "—" of no tons', domRows(doc, 'crushTbody', [16])[0][0], '$0.00');
    assert('crushing: Day Cost / Ton\'s format has no "—" for zero',
      /formatCode="&quot;\$&quot;#,##0\.00"/.test(book.parts['xl/styles.xml']));
    const k6 = E.cells['S' + R('k6')];
    eq('crushing: "_x0041_" is escaped so it does not open as "A"; U+FFFE is dropped',
      (book.parts['xl/worksheets/sheet1.xml'].match(/teardown[^<]*/) || [''])[0], 'teardown _x005F_x0041_  end');
    assert('crushing: no U+FFFE anywhere in the sheet', !book.parts['xl/worksheets/sheet1.xml'].includes('\uFFFE'));
    eq('crushing: comments with quotes, commas and a line break survive', E.val('S' + r1), CRUSH[0].comments);
    eq('crushing: timesheet row marked', E.val('R' + R('tsq-90-c')), 'Payroll timesheet');
    const T = 7 + CRUSH_IDS.length;
    eq('crushing: Totals are SUBTOTALs', ['F','G','H','J','K','M','N','P'].map(c => E.fml(c + T)),
      ['F','G','H','J','K','M','N','P'].map(c => `SUBTOTAL(9,${c}7:${c}${T - 1})`));
    eq('crushing: Totals rate columns are weighted', ['E','I','L','O','Q'].map(c => E.fml(c + T)),
      [`IF(F${T}=0,0,G${T}/F${T})`, `IF(H${T}=0,0,J${T}/H${T})`, `IF(K${T}=0,0,M${T}/K${T})`, `IF(N${T}=0,0,M${T}/N${T})`, `IF(M${T}=0,"—",P${T}/M${T})`]);
    const cost = 772 + 420 + 100 + 140 + 68, tons = 810 + 250 + 100;
    assert('crushing: Totals cost / tons', near(E.val('P' + T), cost) && near(E.val('M' + T), tons), `${E.val('P' + T)} / ${E.val('M' + T)}`);
    const crushSummary = doc.getElementById('crushSummary').textContent;
    assert('crushing: Totals Cost / Ton is the summary bar\'s Avg Cost/Ton', crushSummary.includes(money(cost / tons)) && near(E.val('Q' + T), cost / tons), crushSummary);

    // Days: the table's day header lines, in its order.
    const heads = [...doc.querySelectorAll('#crushTbody tr.crush-day')];
    eq('crushing: Days header', COLS(14).map(c => D.val(c + '5')),
      ['Date','Location','Entries','Hours','Total Payroll','Fuel Gallons','Fuel Cost','Loads','Estimated Tons','Hours Crushing','Tons / Hour','Total Cost','Cost / Ton','Note']);
    eq('crushing: one Days line per day header on screen', heads.length, 4);
    eq('crushing: Days lines are the headers, in order (cost / tons / cost per ton)',
      heads.map((_, i) => { const r = 6 + i; return [D.val('B' + r), money(Number(D.val('L' + r))), String(Number(Number(D.val('I' + r)).toFixed(2))), cptShown(D.val('M' + r))]; }),
      heads.map(h => {
        const id = k => h.querySelector(`[id$="-${k}"]`).textContent.trim();
        return [h.querySelector('.crush-day-meta').textContent.split('·')[1].trim(), id('cost'), id('tons').replace(/,/g, ''), id('costPerTon')];
      }));
    const homer = 6 + 2;   // k8's day, k6's, then 8/27 Homer City
    eq('crushing: 8/27 Homer City line', [D.val('B' + homer), Number(D.val('C' + homer)), Number(D.val('E' + homer)), Number(D.val('G' + homer)), Number(D.val('I' + homer))],
      ['Homer City', 4, HOMER_DAY.payroll, HOMER_DAY.fuel, HOMER_DAY.tons]);
    eq('crushing: Days Tons / Hour and Cost / Ton are formulas', [D.fml('K' + homer), D.fml('L' + homer), D.fml('M' + homer)],
      [`IF(J${homer}>0,I${homer}/J${homer},0)`, `E${homer}+G${homer}`, `IF(I${homer}>0,L${homer}/I${homer},"—")`]);
    eq('crushing: Days — no tons is "—" (text), tons at no cost is 0', [D.val('M7'), Number(D.val('M6'))], ['—', 0]);
    assert('crushing: Days cached cost per ton', near(D.val('M' + homer), dayCpt));
    eq('crushing: no note when the whole day is on the sheet', D.val('N' + homer), null);
  }

  console.log('\n— Crushing · Excel (Product filter hides part of a day) —');
  win.eval("msSet('product', 'crushing').add('2A Modified'); msApply('crushing', 'product');");
  {
    const ids = win.eval('crushShown.map(e => e.row.id)');
    eq('crushing: the filter leaves the two runs that made 2A Modified', ids, ['k1', 'k5']);
    const xl = await download(win, 'crushing', 'xlsx');
    assert('crushing: now "-filtered"', /^quarry-crushing-2026-filtered-/.test(xl.name), xl.name);
    const book = readBook(win, 'crushing (product filter)', xl.buf);
    const E = book.sheets[0], D = book.sheets[1];
    assert('crushing: the operator row still shows the WHOLE day\'s blend, crew rows it hides included',
      near(E.val('Q7'), HOMER_DAY.cost / HOMER_DAY.tons), E.val('Q7'));
    eq('crushing: and so does the table', domRows(doc, 'crushTbody', [16])[0][0], money(HOMER_DAY.cost / HOMER_DAY.tons));
    eq('crushing: the Days line totals the whole day', [Number(D.val('C6')), Number(D.val('L6'))], [4, HOMER_DAY.cost]);
    eq('crushing: and says how much of it the filter left', D.val('N6'), 'Whole day — 1 of its 4 entries match the filters');
    eq('crushing: filter line names the product', E.val('A2'), 'Filters: 2026 · all months · all locations · 2A Modified');
  }

  console.log('\n— Crushing · CSV —');
  {
    const cv = await download(win, 'crushing', 'csv');
    const text = cv.buf.toString('utf8');
    const rows = win.eval(`parseCSV(${JSON.stringify(text)})`);
    const header = rows[0];
    eq('crushing: header carries every template label, then Source', [...templateHeader(win, 'crushing'), 'Source'].sort(), [...header].sort());
    eq('crushing: Source is last', header[header.length - 1], 'Source');
    eq('crushing: in the table\'s column order', header.slice(0, 4), ['Date', 'Location', 'Employee', 'Product']);
    eq('crushing: one line per row on screen (line breaks in comments stay inside their quotes)', rows.length - 1, 2);
    const k1 = rows[1];
    const col = name => k1[header.indexOf(name)];
    eq('crushing: k1 inputs and computed', ['Hourly Rate','Hours','Total Payroll','Loads to Crusher','Tons / Load','Estimated Tons','Hours Crushing','Tons / Hour'].map(col),
      ['30', '8', '240.00', '30', '27', '810.00', '7.5', '108.00']);
    eq('crushing: Cost / Ton is the day blend, to the cent the table shows', col('Cost / Ton'), (HOMER_DAY.cost / HOMER_DAY.tons).toFixed(2));
    eq('crushing: comments round-trip', col('Comments'), CRUSH[0].comments);
    win.__csv = text;
    win.eval("parseBulk('crushing', window.__csv)");
    const parsed = win.eval('bulkParsed.crushing.parsed');
    eq('crushing: importer reads both rows back without errors', parsed.filter(p => p.errors.length).map(p => p.errors), []);
    assert('crushing: …and skips them as duplicates', parsed.every(p => p.duplicate));
    win.eval("msSet('product', 'crushing').clear(); msApply('crushing', 'product');");
    const cv2 = await download(win, 'crushing', 'csv');
    const rows2 = win.eval(`parseCSV(${JSON.stringify(cv2.buf.toString('utf8'))})`);
    const cpt = rows2.slice(1).map(r => r[rows2[0].indexOf('Cost / Ton')]);
    eq('crushing: Cost / Ton — 0.00 for tons at no cost, blank (the table\'s "—") for no tons', [cpt[0], cpt[1]], ['0.00', '']);
  }

  // ── Rounding: the CSV's cents are the table's ──
  console.log('\n— Rounding —');
  {
    // Half cents: 5.05 t × $14.50 = 73.225, 1.41 gal × $3.50 = 4.935, a 6%
    // tax of 4.725. Math.round(v * 100) takes each of these the other way.
    eq('csvCents rounds half cents as the table does', ['5.05*14.5', '1.41*3.5', '5.25*15*0.06', '5*13.25*1.06'].map(x => win.eval(`csvCents(${x})`)),
      ['73.23', '4.94', '4.73', '70.23']);
    const bad = win.eval(`(() => { const out = [];
      for (let t = 1; t <= 4000; t++) for (const p of [3.5, 12.75, 13.25, 14.5, 15, 27, 3.459]) {
        const v = t / 100 * p;
        if (csvCents(v) !== formatMoney(v).replace(/[$,]/g, '')) out.push(t / 100 + ' x ' + p);
      }
      return out; })()`);
    eq('csvCents agrees with formatMoney on 28,000 tons × price products', bad.slice(0, 5), []);
  }

  // ── Dates that are not dates ──
  console.log('\n— Impossible dates —');
  eq('qxDateSerial: a real date is a serial', win.eval('qxDateSerial("2026-11-19")'), serial('2026-11-19'));
  eq('qxDateSerial: 2026-02-30 / 2026-19-11 / 2026-00-10 are not rolled over into other dates',
    win.eval('[qxDateSerial("2026-02-30"), qxDateSerial("2026-19-11"), qxDateSerial("2026-00-10")]'), [null, null, null]);
  eq('…so the cell keeps the text as stored', win.eval('qxDateCell("2026-02-30")'), { v: '2026-02-30', s: 0 });
  eq('a leap day is a date', win.eval('qxDateSerial("2028-02-29")'), serial('2028-02-29'));

  // ── After an edit the table does not re-render for ──
  console.log('\n— Cell edits —');
  {
    // Sales re-dated out of the Year filter: the row stays on screen until the
    // next render, so it stays in the file too, where the table shows it.
    win.setYearFilter('sales', '2026');
    win.eval("msSet('location', 'sales').clear(); msSet('location', 'sales').add('Homer City'); msApply('sales', 'location');");
    const i = win.eval("salesRows.findIndex(r => r.id === 's2')");
    win.eval(`updateSalesCell(${i}, 'date', '2025-11-20')`);
    const onScreen = domRows(doc, 'salesTbody', [3, 5]).length;
    const cv = await download(win, 'sales', 'csv');
    const lines = csvLines(cv.buf.toString('utf8')).split('\r\n').filter(Boolean);
    eq('sales: a row re-dated out of the filter is still on screen, and still in the file', [onScreen, lines.length - 1], [SALES_IDS.length, SALES_IDS.length]);
    eq('…at the place the table shows it, with its new date', lines[1 + SALES_IDS.indexOf('s2')].slice(0, 10), '2025-11-20');
    win.eval(`updateSalesCell(${i}, 'date', '2026-11-20'); renderSales(true);`);
  }

  // ── Disabled when nothing is on screen ──
  console.log('\n— Empty filters —');
  for (const tab of ['daily', 'crushing', 'sales']) {
    win.eval(`msSet('location', '${tab}').clear(); msSet('location', '${tab}').add('Nowhere'); msApply('${tab}', 'location');`);
    assert(`${tab}: Download disables when the filters match nothing`, doc.getElementById(tab + 'ExportBtn').disabled);
  }
  // A direct call with nothing on screen says so instead of saving an empty file.
  const before = win.__saved.length;
  win.downloadTrackingExport('daily', 'xlsx');
  assert('a call with no rows saves nothing', win.__saved.length === before);
  assert('…and says why', /Nothing to download/.test((win.__alerts || []).pop() || ''));

  eq('no uncaught script errors', win.__errors, []);
  eq('no other alerts', win.__alerts || [], []);
  if (OUT_DIR) console.log(`\n  wrote the files to ${OUT_DIR}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
