#!/usr/bin/env node
'use strict';
/**
 * Quarry ▸ Sales Tracking — the ⇩ Download button (Excel / CSV).
 *
 * Run: node scripts/test-quarry-sales-export.js
 *      SALES_EXPORT_OUT=dir node scripts/test-quarry-sales-export.js   (also writes the files out)
 *
 * Loads quarry.html in jsdom with stubbed blob endpoints, narrows the Sales
 * table with its own filters, presses Download for each format and reads the
 * file back:
 *
 *   - both carry exactly the rows the table shows, in its order (newest first)
 *   - the .xlsx unzips the way Excel reads a ZIP and every part parses as XML —
 *     one malformed part is enough for Excel to refuse the whole file — with
 *     dates as date serials, numbers as numbers, Net Sales / Sales Tax / Total
 *     Due as formulas (cached values matching the screen) and a SUBTOTAL row
 *   - the .csv's headers are the Bulk Upload template's, and the page's own
 *     importer reads it straight back with no errors
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT          = path.resolve(__dirname, '..');
const HTML_PATH     = path.join(ROOT, 'quarry.html');
const BRANDING_PATH = path.join(ROOT, 'report-branding.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fixture ────────────────────────────────────────────────────────────────
// Force Turf is tax-exempt; Kunkle is taxable at 6%; the cash customer at 6.35%
// with a name that needs escaping in XML and quoting in CSV.
const LISTS = {
  location: [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:  [{ id: 'p1', name: '6-' }, { id: 'p2', name: '2B' }, { id: 'p3', name: '1B Limestone' }],
  customer: [
    { id: 'c1', name: 'Force Turf Solutions', taxable: false },
    { id: 'c2', name: 'Kunkle Excavating',    taxable: true, taxRate: '6' },
    { id: 'c3', name: 'CASH "TAXABLE" <A&B>, Inc', taxable: true, taxRate: '6.35' },
  ],
  equipment: [], tasks: [], employees: [{ id: 'e1', name: 'Jaimie Boring' }, { id: 'e2', name: 'Nick Detwiler' }],
};
const SALES = [
  { id: 's1', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'Force Turf Solutions', productName: '6-',           tons: 21.88, payment: 'Credit', pricePerTon: 12.75 },
  { id: 's2', date: '2026-11-20', locationName: 'Homer City', employeeName: 'Nick Detwiler', customerName: 'Force Turf Solutions', productName: '6-',           tons: 22.35, payment: 'Credit', pricePerTon: 12.75 },
  { id: 's3', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'Kunkle Excavating',    productName: '2B',           tons: 3.02,  payment: 'Credit', pricePerTon: 14.5 },
  // Submitted on the Quarry Sales form — read-only on screen, still exported.
  { id: 'qss-41-row', date: '2026-11-19', locationName: 'Homer City', employeeName: 'Jaimie Boring', customerName: 'CASH "TAXABLE" <A&B>, Inc', productName: '1B Limestone', tons: 4.16, payment: 'Cash', pricePerTon: 27 },
  // Other pit — filtered out below.
  { id: 's5', date: '2026-11-18', locationName: 'McGees Mills', employeeName: 'Nick Detwiler', customerName: 'Kunkle Excavating', productName: '2B', tons: 10, payment: 'Cash', pricePerTon: 15 },
  // Other year — filtered out by the year filter.
  { id: 's6', date: '2025-06-01', locationName: 'Homer City', employeeName: 'Nick Detwiler', customerName: 'Kunkle Excavating', productName: '2B', tons: 5, payment: 'Cash', pricePerTon: 13 },
  // A row nobody has finished: no tons, no price. Exports as blanks, not NaN.
  { id: 's7', date: '2026-11-21', locationName: 'Homer City', employeeName: '', customerName: 'Kunkle Excavating', productName: '2B', tons: '', payment: '', pricePerTon: '' },
];
const BLOBS = {
  fct_quarry_lists: LISTS, fct_quarry_sales: SALES, fct_quarry_crushing: [], fct_quarry_daily: [],
  fct_quarry_inventory: {}, fct_quarry_loss_pct: {}, fct_presence: {},
};

// Visible after Year = 2026 and Location = Homer City, newest first; rows of
// one date keep their stored order.
const EXPECT_IDS = ['s7', 's2', 's1', 's3', 'qss-41-row'];

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

// ── Stored-ZIP reader (the writer never compresses) ─────────────────────────
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

async function main() {
  const dom = loadPage();
  const win = dom.window, doc = win.document;
  for (let i = 0; i < 80 && !win.eval('typeof listsLoaded !== "undefined" && listsLoaded'); i++) await sleep(25);

  win.switchTab('sales');
  for (let i = 0; i < 80 && !win.eval('salesLoaded'); i++) await sleep(25);
  await sleep(50);
  eq('no uncaught script errors on load', win.__errors, []);

  // ── The button ──
  console.log('\n— Toolbar —');
  const btn = doc.getElementById('salesExportBtn');
  assert('Download button sits in the Sales toolbar', !!btn && !!btn.closest('#tab-sales .sales-toolbar'));
  assert('Download button is enabled once sales load', btn && !btn.disabled);
  const menu = doc.querySelector('#salesExportMenu .ms-menu');
  assert('menu starts closed', menu && menu.hidden);
  btn.click();
  assert('clicking Download opens the menu', !menu.hidden && btn.getAttribute('aria-expanded') === 'true');
  doc.body.click();
  assert('a click elsewhere closes it', menu.hidden && btn.getAttribute('aria-expanded') === 'false');
  btn.click();
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert('Escape closes it', menu.hidden);
  const opts = [...doc.querySelectorAll('#salesExportMenu .export-opt')].map(b => b.getAttribute('onclick'));
  eq('two choices: Excel and CSV', opts, ["downloadSalesExport('xlsx')", "downloadSalesExport('csv')"]);

  // Narrow the table: year 2026, Homer City only.
  win.setYearFilter('sales', '2026');
  win.eval("msSet('location', 'sales').add('Homer City'); msApply('sales', 'location');");
  const screenIds = win.eval('visibleSalesEntries().map(e => e.row.id)');
  eq('table shows the filtered rows, newest first', screenIds, EXPECT_IDS);
  const screenSummary = doc.getElementById('salesSummary').textContent;

  // ── Excel ──
  console.log('\n— Excel (.xlsx) —');
  btn.click();
  doc.querySelector("#salesExportMenu .export-opt[onclick*=\"xlsx\"]").click();
  assert('choosing a format closes the menu', menu.hidden);
  const xl = win.__saved.shift();
  assert('an .xlsx was saved', xl && xl.blob);
  assert('file name carries the year, "-filtered" and today', /^quarry-sales-2026-filtered-\d{4}-\d{2}-\d{2}\.xlsx$/.test(xl.name), xl.name);
  eq('blob type is the xlsx MIME', xl.blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const xbuf = await blobBuffer(xl.blob);
  const parts = unzipStored(xbuf);
  eq('package parts', Object.keys(parts).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const parser = new win.DOMParser();
  for (const [name, xml] of Object.entries(parts)) {
    const d = parser.parseFromString(xml, 'application/xml');
    assert(`${name} parses as XML`, !d.getElementsByTagName('parsererror').length);
  }

  const sheet = parser.parseFromString(parts['xl/worksheets/sheet1.xml'], 'application/xml');
  const cells = {};
  for (const c of sheet.getElementsByTagName('c')) {
    const f = c.getElementsByTagName('f')[0];
    const v = c.getElementsByTagName('v')[0];
    const t = c.getElementsByTagName('t')[0];
    cells[c.getAttribute('r')] = { f: f ? f.textContent : null, v: v ? v.textContent : (t ? t.textContent : null), s: c.getAttribute('s') };
  }
  const val = ref => (cells[ref] || {}).v;
  const fml = ref => (cells[ref] || {}).f;

  // The file is the table: what renderSales put on screen, row for row, in
  // its order. visibleSalesEntries() restates renderSales' filter and sort, so
  // this is the check that keeps the two from drifting apart.
  const cellText = el => { const i = el.querySelector('input'); return i ? i.value : el.textContent.trim(); };
  const domRows = [...doc.querySelectorAll('#salesTbody tr')].map(tr => {
    const td = [...tr.children];
    return [cellText(td[0]), cellText(td[3]), cellText(td[5])];
  });
  const isoOf = n => new Date((Number(n) - 25569) * 86400000).toISOString().slice(0, 10);
  const fileRows = EXPECT_IDS.map((_, i) => {
    const r = 6 + i;
    return [isoOf(val('A' + r)), val('D' + r), val('F' + r) == null ? '' : String(Number(val('F' + r)))];
  });
  eq('the file is the rendered table, row for row', fileRows, domRows);

  assert('title names the company',/^Sales Tracking — Test Co$/.test(val('A1')), val('A1'));
  eq('filter line says what was on screen', val('A2'), 'Filters: 2026 · all months · Homer City · all customers · all products');
  assert('row count line', /^5 rows · exported /.test(val('A3')), val('A3'));
  eq('header row', ['A','B','C','D','E','F','G','H','I','J','K','L','M'].map(c => val(c + '5')),
    ['Date','Location','Employee','Customer','Product','Tons','Payment','Price / Ton','Tax Rate','Sales Tax','Net Sales','Total Due','Source']);

  // Rows 6..10 in table order.
  const rowFor = id => 6 + EXPECT_IDS.indexOf(id);
  const serial = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000) + 25569;
  eq('dates are Excel date serials', EXPECT_IDS.map(id => Number(val('A' + rowFor(id)))),
     EXPECT_IDS.map(id => serial(SALES.find(s => s.id === id).date)));
  const s1 = rowFor('s1');
  eq('s1 text cells', ['B','C','D','E','G'].map(c => val(c + s1)), ['Homer City','Jaimie Boring','Force Turf Solutions','6-','Credit']);
  eq('s1 tons / price are numbers', [Number(val('F' + s1)), Number(val('H' + s1))], [21.88, 12.75]);
  eq('s1 Net Sales is Tons × Price', fml('K' + s1), `F${s1}*H${s1}`);
  assert('s1 Net Sales cached value', near(val('K' + s1), 21.88 * 12.75), val('K' + s1));
  eq('s1 Sales Tax is Net × Rate', fml('J' + s1), `K${s1}*I${s1}`);
  eq('s1 exempt: rate 0, tax 0', [Number(val('I' + s1)), Number(val('J' + s1))], [0, 0]);
  eq('s1 Total Due is Net + Tax', fml('L' + s1), `K${s1}+J${s1}`);
  eq('s1 source', val('M' + s1), 'Sales Tracking');

  const s3 = rowFor('s3');
  assert('taxable customer: rate is 6%', near(val('I' + s3), 0.06), val('I' + s3));
  assert('taxable customer: tax cached', near(val('J' + s3), 3.02 * 14.5 * 0.06), val('J' + s3));
  assert('taxable customer: total due cached', near(val('L' + s3), 3.02 * 14.5 * 1.06), val('L' + s3));

  const q = rowFor('qss-41-row');
  eq('XML-hostile customer name survives', val('D' + q), 'CASH "TAXABLE" <A&B>, Inc');
  assert('6.35% rate', near(val('I' + q), 0.0635), val('I' + q));
  eq('form-submitted sale is marked', val('M' + q), 'Quarry Sales form');

  const s7 = rowFor('s7');
  eq('unfinished row: tons / price blank, not NaN', [val('F' + s7), val('H' + s7)], [null, null]);
  assert('unfinished row: net 0', near(val('K' + s7), 0));
  assert('no NaN anywhere', !/NaN|Infinity/.test(parts['xl/worksheets/sheet1.xml']));

  const T = 6 + EXPECT_IDS.length;
  eq('Totals row label', val('A' + T), 'Totals');
  eq('Totals are SUBTOTALs over the data', ['F','J','K','L'].map(c => fml(c + T)),
     ['F','J','K','L'].map(c => `SUBTOTAL(9,${c}6:${c}${T - 1})`));
  const vis = SALES.filter(s => EXPECT_IDS.includes(s.id));
  const rate = { 'Kunkle Excavating': 0.06, 'CASH "TAXABLE" <A&B>, Inc': 0.0635 };
  const tons = vis.reduce((n, s) => n + (Number(s.tons) || 0), 0);
  const net  = vis.reduce((n, s) => n + (Number(s.tons) || 0) * (Number(s.pricePerTon) || 0), 0);
  const tax  = vis.reduce((n, s) => n + (Number(s.tons) || 0) * (Number(s.pricePerTon) || 0) * (rate[s.customerName] || 0), 0);
  assert('Totals: tons', near(val('F' + T), tons), val('F' + T));
  assert('Totals: net sales', near(val('K' + T), net), val('K' + T));
  assert('Totals: sales tax', near(val('J' + T), tax), val('J' + T));
  assert('Totals: total due', near(val('L' + T), net + tax), val('L' + T));
  eq('Totals: Price / Ton is the weighted average', fml('H' + T), `IF(F${T}=0,0,K${T}/F${T})`);
  assert('Totals: weighted average cached', near(val('H' + T), net / tons), val('H' + T));
  // The on-screen summary bar is the same filtered slice.
  const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert('Totals match the summary bar (Net Sales)', screenSummary.includes(money(net)), screenSummary);
  assert('Totals match the summary bar (Total Due)', screenSummary.includes(money(net + tax)), screenSummary);

  const af = sheet.getElementsByTagName('autoFilter')[0];
  eq('AutoFilter covers header + data, not the Totals row', af && af.getAttribute('ref'), `A5:M${T - 1}`);
  const pane = sheet.getElementsByTagName('pane')[0];
  eq('header row is frozen', pane && pane.getAttribute('ySplit'), '5');
  assert('header repeats on printed pages', /_xlnm\.Print_Titles[^>]*>'Sales'!\$5:\$5</.test(parts['xl/workbook.xml']));

  // ── CSV ──
  console.log('\n— CSV —');
  btn.click();
  doc.querySelector("#salesExportMenu .export-opt[onclick*=\"csv\"]").click();
  const cv = win.__saved.shift();
  assert('a .csv was saved', cv && cv.blob);
  assert('csv file name', /^quarry-sales-2026-filtered-\d{4}-\d{2}-\d{2}\.csv$/.test(cv.name), cv.name);
  const csvText = (await blobBuffer(cv.blob)).toString('utf8');
  assert('starts with a UTF-8 BOM', csvText.charCodeAt(0) === 0xFEFF);
  const lines = csvText.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const templateHeader = win.eval(`BULK_CONFIGS.sales.templateLayout.map(it => typeof it === 'string'
      ? BULK_CONFIGS.sales.fields.find(f => f.name === it).label : it.label).join(',')`);
  eq('header is the Bulk Upload template\'s', lines[0], templateHeader);
  eq('one line per row on screen', lines.length - 1, EXPECT_IDS.length);
  eq('s1 line', lines[1 + EXPECT_IDS.indexOf('s1')], '2026-11-19,Homer City,Jaimie Boring,Force Turf Solutions,6-,21.88,Credit,12.75,0.00,278.97,278.97');
  eq('quoted name line', lines[1 + EXPECT_IDS.indexOf('qss-41-row')],
     '2026-11-19,Homer City,Jaimie Boring,"CASH ""TAXABLE"" <A&B>, Inc",1B Limestone,4.16,Cash,27,7.13,112.32,119.45');
  eq('unfinished row line', lines[1 + EXPECT_IDS.indexOf('s7')], '2026-11-21,Homer City,,Kunkle Excavating,2B,,,,0.00,0.00,0.00');

  // Round trip: the page's own importer reads the file back.
  win.__csv = csvText;
  win.eval("parseBulk('sales', window.__csv)");
  const parsed = win.eval('bulkParsed.sales.parsed');
  const withErrors = parsed.filter(p => p.errors.length);
  // The unfinished row has no tons/price — required on import — so it is the
  // one the importer should flag; every complete row reads back clean.
  eq('importer reads every complete row back without errors',
     withErrors.map(p => p.rowNum), [1 + EXPECT_IDS.indexOf('s7') + 1]);
  assert('…and flags them as duplicates of what is already here (no double-import)',
     parsed.filter(p => !p.errors.length).every(p => p.duplicate));

  // ── Disabled when nothing is on screen ──
  console.log('\n— Empty filter —');
  win.eval("msSet('location', 'sales').clear(); msSet('location', 'sales').add('Nowhere'); msApply('sales', 'location');");
  assert('Download disables when the filters match nothing', doc.getElementById('salesExportBtn').disabled);

  eq('no uncaught script errors', win.__errors, []);
  eq('no alerts', win.__alerts || [], []);

  if (process.env.SALES_EXPORT_OUT) {
    fs.mkdirSync(process.env.SALES_EXPORT_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_EXPORT_OUT, xl.name), xbuf);
    fs.writeFileSync(path.join(process.env.SALES_EXPORT_OUT, cv.name), csvText);
    console.log(`\n  wrote ${xl.name} and ${cv.name} to ${process.env.SALES_EXPORT_OUT}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
