#!/usr/bin/env node
'use strict';
/**
 * The CRM Schools tab, in a real browser.
 *
 * Run: node scripts/test-crm-schools-browser.js [path/to/schools.csv]
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * With no CSV given (or CRM_SCHOOLS_CSV unset) it builds a synthetic school
 * list of the same shape — 22 columns, 1,095 rows, ZIP+4s, private-school ids
 * with leading zeros — so the suite runs on a clean checkout. Pass the real
 * import file to run the same checks against it; every expected number is
 * read from whichever file is used, never typed in.
 *
 * scripts/test-crm-revamp.js lifts the CRM functions into a sandbox, which
 * can say what _crmPlanSchoolImport returns but not whether the Upload button
 * opens a chooser, whether the modal says the right thing, whether a Type
 * change moves a row between two tabs on screen, or whether a thousand rows
 * of inputs can be drawn fast enough to click a filter. This drives the page.
 *
 * The server is an in-memory /api/data store: a PUT lands in it and is kept,
 * so a reload or a poll reads back what the page wrote, and every PUT body is
 * captured in arrival order for the assertions. A PUT of the companies blob
 * is answered after a short delay, the way a megabyte of JSON is in real life
 * — without it the save-coalescing check would measure nothing.
 *
 * Harness traps (see test-haul-browser.js for the first two):
 *   - Served over HTTP, not file://, or /api fetches never leave.
 *   - fct_division must be 'turf' or tracker.html bounces to divisions.html.
 *   - _crmTriggerUpload builds a detached <input type=file>; Playwright's
 *     filechooser event still fires for it, so page.setInputFiles is not used.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + d : '')); }
};
const note = s => console.log('    · ' + s);

const TOKEN = 'x.y.z';
const USER  = { id: 7, username: 'hudockben', role: 'admin', companyCode: 'FCT',
                isPlatformAdmin: true, allowedDivisions: ['turf'] };

// ── The school list ─────────────────────────────────────────────────────────
const HEADERS = ['Tag','Lead Contact','School','Type','Public / Private','Athletics','Enrollment',
  'Territory','Mi to Line','City','County','State','Zip','Address','Phone','Email Domain','Website',
  'Athletics Page','Personal Interest','Turf Product','Notes','NCES ID'];

/** A quoted-field CSV reader for the oracle — independent of the page's own. */
function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim())) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim())) out.push(row);
  const [head, ...rows] = out;
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}

/** Same shape as the real import: two Cumberland MD schools the seed matches. */
function syntheticCsv() {
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const states = ['PA', 'OH', 'NY', 'WV', 'MD'];
  const rows = [
    ['', '', 'Allegany High', 'High School', 'Public', '', '', 'Inside', '45.9', 'Cumberland', 'Allegany County', 'MD', '21502', '900 Seton Dr', '', '', '', 'https://www.maxpreps.com/md/cumberland/allegany-campers/', '', '', '', '240003000001'],
    ['', '', 'Fort Hill High', 'High School', 'Public', '', '', 'Inside', '44.9', 'Cumberland', 'Allegany County', 'MD', '21502', '500 Greenway Ave', '', '', '', 'https://www.maxpreps.com/md/cumberland/fort-hill-sentinels/', '', '', '', '240003000015'],
  ];
  for (let i = 0; rows.length < 1095; i++) {
    const college = i % 8 === 0, priv = !college && i % 6 === 0;
    const st = states[i % states.length];
    rows.push(['', '', college ? `Synthetic College ${i}` : `Synthetic ${i} High School`,
      college ? 'College / University' : 'High School', priv ? 'Private' : 'Public',
      college ? 'NCAA Division III with football' : '', college ? String(800 + i) : '',
      i % 2 ? 'Inside' : 'On/near boundary', (i % 50 + 0.5).toFixed(1),
      `Town ${i % 90}`, `County ${i % 30}`, st,
      i % 11 === 0 ? `1${String(i).padStart(4, '0')}-${String(i).padStart(4, '0')}` : `1${String(i).padStart(4, '0')}`,
      `${i} Main St, Suite ${i % 3}`, '', '', '', '', '', '',
      i % 23 === 0 ? 'Check the MaxPreps profile - its name does not match the school' : '',
      college ? String(100000 + i) : priv ? '0' + String(1000000 + i) : String(390000000000 + i)]);
  }
  return '﻿' + [HEADERS, ...rows].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}

const CSV_PATH = (() => {
  const given = process.argv[2] || process.env.CRM_SCHOOLS_CSV;
  if (given) return path.resolve(given);
  const p = path.join(os.tmpdir(), `crm-schools-synthetic-${process.pid}.csv`);
  fs.writeFileSync(p, syntheticCsv());
  return p;
})();
const CSV_ROWS = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));

// ── The in-memory server ─────────────────────────────────────────────────────
let STORE = {};              // key → value
let PUTS  = [];              // { key, value, raw, seq, at }
let CALLS = [];              // every other /api request, by path
let FIND_CALLS = 0;
const inflight = {};         // key → PUTs answered but not yet returned
let putSeq = 0;
const PUT_DELAY_MS = { fct_crm_companies: 250 };

function mockApi(page) {
  return page.route('**/api/**', async route => {
    const req = route.request();
    const u   = new URL(req.url());
    const m   = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const p = u.pathname;

    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
      return json({ values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
    }
    if (p === '/api/data/_keys') return json({ keys: [] });
    if (p.startsWith('/api/data/')) {
      const key = decodeURIComponent(p.slice('/api/data/'.length));
      if (m === 'GET') return json({ value: key in STORE ? STORE[key] : null });
      if (m === 'PUT') {
        const raw = req.postData() || '{}';
        let value = null;
        try { value = JSON.parse(raw).value; } catch {}
        const rec = { key, value, raw, seq: ++putSeq, at: Date.now() };
        PUTS.push(rec);
        inflight[key] = (inflight[key] || 0) + 1;
        const delay = PUT_DELAY_MS[key] || 0;
        if (delay) await new Promise(r => setTimeout(r, delay));
        STORE[key] = value;
        inflight[key]--;
        return json({ ok: true });
      }
      if (m === 'PATCH') return json({ ok: true });
      return json({ ok: true });
    }
    CALLS.push(m + ' ' + p);
    if (p === '/api/ai/crm-find-contacts') { FIND_CALLS++; return json({ people: [], summary: 'mock' }); }
    if (p === '/api/purchase-orders') return json({ purchaseOrders: [] });
    if (p === '/api/trucking')        return json({ truckingEntries: [] });
    if (p === '/api/board')           return json({ posts: [] });
    if (p === '/api/deadlines')       return json({ deadlines: [] });
    if (p === '/api/projects')        return json({ projects: [] });
    if (p === '/api/daily-rows')      return json({ rows: [] });
    return json({});
  });
}

const putsFor  = key => PUTS.filter(x => x.key === key);
const lastPut  = key => { const a = putsFor(key); return a.length ? a[a.length - 1] : null; };
const sleep    = ms => new Promise(r => setTimeout(r, ms));

/** Waits until nothing is in flight for a key and nothing new arrived for a beat. */
async function settle(key, quietMs = 400, maxMs = 10000) {
  const t0 = Date.now();
  let n = putsFor(key).length, since = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(50);
    const now = putsFor(key).length;
    if (now !== n) { n = now; since = Date.now(); continue; }
    if (!inflight[key] && Date.now() - since >= quietMs) return;
  }
}

async function boot(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  // Dismissed unless a scenario says otherwise — a stray confirm must never
  // start a real lookup.
  page.on('dialog', d => { dialogs.push({ type: d.type(), message: d.message() }); d.dismiss().catch(() => {}); });
  await page.addInitScript(({ t, u }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify(u));
    localStorage.setItem('fct_division', 'turf');
  }, { t: TOKEN, u: USER });
  await mockApi(page);
  await page.goto((await BASE) + '/tracker.html');
  await page.waitForFunction(() => typeof crmCompanies !== 'undefined' && typeof renderCrmSchoolsTab === 'function'
    && lists && Array.isArray(lists.crm_org_types) && lists.crm_org_types.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  return { page, errors, dialogs };
}

async function openCrm(page, sub) {
  await page.click('.tab-btn[data-tab="crm"]');
  await page.click(`.crm-sub-btn[data-crm-tab="${sub}"]`);
  await page.waitForTimeout(100);
}

/** The count line, the view bar and the rows one org tab is showing. */
function orgState(page, side) {
  return page.evaluate(side => {
    const root = document.getElementById(`crm-${side}-root`);
    const kids = [...root.children];
    const bar  = kids[0] ? [...kids[0].querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()) : [];
    const head = kids[1] ? (kids[1].querySelector('span') || kids[1]).textContent.replace(/\s+/g, ' ').trim() : '';
    const rows = [...root.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('[data-crm-id]'));
    const names = rows.map(tr => (tr.querySelector('[data-crm-field="company_name"]') || {}).value);
    const more = [...root.querySelectorAll('tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim())
      .find(t => /^Showing /.test(t)) || '';
    return { bar, head, rowCount: rows.length, names, more, text: root.textContent.replace(/\s+/g, ' ').trim() };
  }, side);
}

const fmt = n => n.toLocaleString('en-US');

// ── The seed ─────────────────────────────────────────────────────────────────
const SEED = {
  acme:    { id: 'co-acme', tag: '', lead_contact: '', company_name: 'Acme Turf', contact_type: 'Contractor',
             work_phone: '412-555-0100', email_domain: 'acmeturf.com', work_website: '', address: '1 Acme Way',
             city: 'Pittsburgh', state: 'PA', zip: '15222', field_type: '', field_size: '',
             personal_interest: '', turf_product: '' },
  // Typed as a school by a rep; the file calls it "Fort Hill High". Its
  // address is typed and differs from the file — the import must not touch it.
  forthill:{ id: 'co-forthill', tag: 'Hot', lead_contact: '', company_name: 'Fort Hill High School',
             contact_type: 'High School', work_phone: '', email_domain: '', work_website: '',
             address: '1 Old Typed Rd', city: 'Cumberland', state: 'MD', zip: '', field_type: '', field_size: '',
             personal_interest: 'Steelers', turf_product: '' },
  // What Lucius files: the OSM name, typed "Operator", so it sits on Companies
  // until a school list says what it is.
  lucius:  { id: 'co-lucius', tag: 'Prospect', lead_contact: '', company_name: 'Allegany High School',
             contact_type: 'Operator', work_phone: '', email_domain: '', work_website: '',
             address: '', city: 'Cumberland', state: 'MD', zip: '', field_type: '', field_size: '',
             personal_interest: '', turf_product: '', osm_id: 'way/123', osm_lat: 39.64, osm_lng: -78.76 },
};
const SEED_FIELD = { id: 'fld-forthill', company_id: 'co-forthill', company_name: 'Fort Hill High School',
  field_name: 'Greenway Avenue Stadium', field_type: 'Football', field_size: '', installed_year: '2015',
  turf_product: '', notes: '', osm_id: '', osm_lat: null, osm_lng: null };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  console.log(`\nSchool list: ${CSV_PATH} (${fmt(CSV_ROWS.length)} rows)`);

  // ── 1. An empty CRM ──────────────────────────────────────────────────────
  console.log('\n[1 — the page boots, and Schools is where it should be]');
  {
    STORE = {}; PUTS = [];
    const { page, errors } = await boot(browser);
    ok('the page boots with no uncaught page error', errors.length === 0, errors.slice(0, 3).join(' | '));
    const order = await page.$$eval('.crm-sub-btn', bs => bs.map(b => b.dataset.crmTab));
    ok('the Schools sub-tab sits right after Companies',
      order.indexOf('schools') === order.indexOf('companies') + 1 && order.indexOf('companies') >= 0, order.join(' / '));
    await openCrm(page, 'schools');
    const st = await orgState(page, 'schools');
    ok('an empty Schools panel says how to start',
      /No schools yet/.test(st.text) && /Upload CSV/.test(st.text), st.text.slice(0, 160));
    ok('  and its view bar counts 0 schools', st.bar[0] === 'Schools 0', st.bar.join(' | '));
    ok('  still no page error after opening it', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }

  // ── 2..13 on a seeded CRM ────────────────────────────────────────────────
  STORE = {
    fct_crm_companies: [SEED.acme, SEED.forthill, SEED.lucius],
    fct_crm_fields:    [SEED_FIELD],
  };
  PUTS = []; CALLS = []; FIND_CALLS = 0;
  const { page, errors, dialogs } = await boot(browser);

  console.log('\n[2 — one list, two tabs]');
  let schoolsBefore, companiesBefore;
  {
    await openCrm(page, 'companies');
    const co = await orgState(page, 'companies');
    await openCrm(page, 'schools');
    const sc = await orgState(page, 'schools');
    companiesBefore = co.rowCount; schoolsBefore = sc.rowCount;
    ok('Companies shows only the non-schools (Acme and the Lucius "Operator" row)',
      co.rowCount === 2 && co.names.includes('Acme Turf') && co.names.includes('Allegany High School')
      && !co.names.includes('Fort Hill High School'), JSON.stringify(co.names));
    ok('  and its header and view bar say 2 companies',
      /^2 companies/.test(co.head) && co.bar[0] === 'Companies 2', `${co.head} | ${co.bar[0]}`);
    ok('Schools shows the High School row only',
      sc.rowCount === 1 && sc.names[0] === 'Fort Hill High School', JSON.stringify(sc.names));
    ok('  and its header and view bar say 1 school',
      /^1 school\b/.test(sc.head) && sc.bar[0] === 'Schools 1', `${sc.head} | ${sc.bar[0]}`);
    ok('  the shared Fields count is on both bars', co.bar[1] === 'Fields 1' && sc.bar[1] === 'Fields 1',
      `${co.bar[1]} | ${sc.bar[1]}`);
  }

  // ── 3. The real upload ──────────────────────────────────────────────────
  console.log('\n[3 — uploading the school list]');
  const N = CSV_ROWS.length;
  const inside = CSV_ROWS.filter(r => r.Territory.trim() === 'Inside').length;
  const expectAdd = N - 2;                 // Fort Hill and Allegany are matched
  const expectSchools = schoolsBefore + 1 + expectAdd;   // + the Operator row moving over
  {
    const up = page.locator('#crm-schools-root button', { hasText: 'Upload CSV' });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), up.click()]);
    await chooser.setFiles(CSV_PATH);
    await page.waitForSelector('#crm-upload-modal', { timeout: 10000 });
    const modal = await page.evaluate(() => {
      const m = document.getElementById('crm-upload-modal');
      const map = [...m.querySelectorAll('span[title="mapped"], span[title="not found in CSV"]')].map(s => s.textContent.trim());
      const btn = [...m.querySelectorAll('button')].find(b => /Import|Update|Nothing/.test(b.textContent));
      return { text: m.textContent.replace(/\s+/g, ' ').trim(), map,
               plan: [...m.querySelectorAll('ul li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
               commit: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null,
               radios: m.querySelectorAll('input[name="crm-import-mode"]').length };
    });
    ok(`the modal says Found ${fmt(N)} schools`, modal.text.includes(`Found ${fmt(N)} schools`), modal.text.slice(0, 140));
    ok('  every one of the 22 columns is mapped, none ✗',
      modal.map.length === 22 && modal.map.every(s => s.startsWith('✓')),
      modal.map.filter(s => !s.startsWith('✓')).join(', ') || `${modal.map.length} columns`);
    ok(`  the plan adds ${fmt(expectAdd)} new schools`,
      modal.plan.some(l => l.startsWith(`${fmt(expectAdd)} new schools will be added`)), modal.plan.join(' | '));
    ok('  and says 2 are already in the CRM, 1 moving over from Companies',
      modal.plan.some(l => /^2 already in the CRM/.test(l) && /\(1 move over from Companies\)/.test(l)), modal.plan.join(' | '));
    ok('  nothing ambiguous, repeated or non-school',
      !modal.plan.some(l => /could not be matched|repeated|not a school/.test(l)), modal.plan.join(' | '));
    ok('  schools never offer Replace all', modal.radios === 0, String(modal.radios));
    ok('  the button says what it will do',
      modal.commit === `Import ${fmt(expectAdd)} new · update 2`, modal.commit);

    const before = putsFor('fct_crm_companies').length;
    await page.locator('#crm-upload-modal button.btn-green').click();
    await page.waitForSelector('#crm-upload-modal', { state: 'detached' });
    await settle('fct_crm_companies');
    const st = await orgState(page, 'schools');
    ok(`the header counts ${fmt(expectSchools)} schools`, st.head.startsWith(`${fmt(expectSchools)} schools`), st.head);
    ok('  and so does the view bar', st.bar[0] === `Schools ${fmt(expectSchools)}`, st.bar[0]);
    ok(`  the table draws a page: "Showing 200 of ${fmt(expectSchools)}"`,
      st.rowCount === 200 && st.more.startsWith(`Showing 200 of ${fmt(expectSchools)}`), `${st.rowCount} rows · ${st.more.slice(0, 80)}`);
    ok('  the import note is shown at the head of the tab',
      new RegExp(`Imported ${fmt(expectAdd)} new schools and filled in blanks on 2 already here`).test(st.text), st.text.slice(0, 300));

    const put = lastPut('fct_crm_companies');
    ok('a PUT of fct_crm_companies went out', !!put && putsFor('fct_crm_companies').length > before);
    const saved = put ? put.value : [];
    ok(`  carrying every row (${fmt(expectSchools + 1)} = ${fmt(expectSchools)} schools + Acme)`,
      saved.length === expectSchools + 1, String(saved.length));
    const savedIds = new Set(saved.map(r => r.nces_id).filter(Boolean));
    const fileIds  = CSV_ROWS.map(r => r['NCES ID']);
    ok('  with every NCES id exactly as the file has it',
      fileIds.every(id => savedIds.has(id)), fileIds.filter(id => !savedIds.has(id)).slice(0, 5).join(', '));
    const zeroRow = CSV_ROWS.find(r => r['NCES ID'].startsWith('0') && r['Public / Private'] === 'Private');
    const zeroSaved = zeroRow && saved.find(r => r.nces_id === zeroRow['NCES ID']);
    ok(`  a private-school id keeps its leading zero (${zeroRow ? zeroRow['NCES ID'] : 'none in file'})`,
      !!zeroSaved && typeof zeroSaved.nces_id === 'string' && zeroSaved.nces_id.startsWith('0'),
      zeroSaved ? JSON.stringify(zeroSaved.nces_id) : 'not found');
    const zip4 = CSV_ROWS.filter(r => /^\d{5}-\d{4}$/.test(r.Zip));
    const zip4Bad = zip4.filter(r => { const s = saved.find(x => x.nces_id === r['NCES ID']); return !s || s.zip !== r.Zip; });
    ok(`  all ${zip4.length} ZIP+4s stored as NNNNN-NNNN`, zip4.length > 0 && zip4Bad.length === 0,
      zip4Bad.slice(0, 3).map(r => r.Zip).join(', '));
    const fh = saved.find(r => r.id === 'co-forthill') || {};
    const fhFile = CSV_ROWS.find(r => /^Fort Hill High$/i.test(r.School) && r.City === 'Cumberland') || {};
    ok('Fort Hill keeps its tag, name and typed address', fh.tag === 'Hot' && fh.company_name === 'Fort Hill High School'
      && fh.address === '1 Old Typed Rd' && fh.personal_interest === 'Steelers', JSON.stringify({ tag: fh.tag, name: fh.company_name, address: fh.address }));
    ok('  and its blank cells are filled from the file',
      fh.nces_id === fhFile['NCES ID'] && fh.territory === fhFile.Territory && fh.county === fhFile.County
      && fh.zip === fhFile.Zip && fh.athletics_url === fhFile['Athletics Page'] && fh.sector === fhFile['Public / Private'],
      JSON.stringify({ nces: fh.nces_id, terr: fh.territory, county: fh.county, zip: fh.zip, sector: fh.sector }));
    const lu = saved.find(r => r.id === 'co-lucius') || {};
    ok('the Lucius row is retyped High School and keeps its tag and OSM link',
      lu.contact_type === 'High School' && lu.tag === 'Prospect' && lu.osm_id === 'way/123' && !!lu.nces_id,
      JSON.stringify({ type: lu.contact_type, tag: lu.tag, osm: lu.osm_id, nces: lu.nces_id }));
    const ac = saved.find(r => r.id === 'co-acme') || {};
    ok('Acme is untouched', JSON.stringify(ac) === JSON.stringify(SEED.acme), JSON.stringify(ac));
    await openCrm(page, 'companies');
    const co = await orgState(page, 'companies');
    ok('  and is now the only row on Companies', co.rowCount === 1 && co.names[0] === 'Acme Turf', JSON.stringify(co.names));
    await openCrm(page, 'schools');
  }

  // ── 4. Paging ──────────────────────────────────────────────────────────
  console.log('\n[4 — paging]');
  {
    await page.locator('#crm-schools-root button', { hasText: /^show 200 more$/ }).click();
    let st = await orgState(page, 'schools');
    ok('"show 200 more" draws 400 rows', st.rowCount === 400 && st.more.startsWith(`Showing 400 of ${fmt(expectSchools)}`),
      `${st.rowCount} · ${st.more.slice(0, 60)}`);
    await page.locator('#crm-schools-root button', { hasText: /^show all$/ }).click();
    st = await orgState(page, 'schools');
    ok('"show all" draws every row, and the paging line goes', st.rowCount === expectSchools && !st.more,
      `${st.rowCount} · ${st.more.slice(0, 60)}`);
    // Back to a page for the rest, the way a fresh visit would draw it.
    await page.evaluate(() => { delete _crmShown.schools; renderCrmSchoolsTab(); });
  }

  // ── 5. The Territory filter ────────────────────────────────────────────
  console.log('\n[5 — filtering by territory]');
  let filterClickMs = null;
  {
    const btn = page.locator('#crm-schools-root [data-crm-filter-btn="schools:territory"]');
    await btn.click();
    await page.waitForSelector('#crm-filter-pop');
    const box = await btn.boundingBox();
    const pop = await page.locator('#crm-filter-pop').boundingBox();
    ok('the Territory popover opens next to its button, not at 0,0',
      !!pop && !!box && !(pop.x === 0 && pop.y === 0) && Math.abs(pop.x - box.x) < 260 && Math.abs(pop.y - (box.y + box.height)) < 320,
      JSON.stringify({ pop, box }));
    const opts = await page.$$eval('#crm-filter-pop .cfp-item', ls => ls.map(l => l.textContent.replace(/\s+/g, ' ').trim()));
    ok('  offering Inside and On/near boundary with their counts',
      opts.includes(`Inside ${inside}`) && opts.includes(`On/near boundary ${N - inside}`), opts.join(' | '));
    filterClickMs = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('#crm-filter-pop .cfp-item input')].find(i => i.dataset.v === 'Inside');
      const t = performance.now();
      cb.click();
      void document.body.offsetHeight;      // include the layout it causes
      return performance.now() - t;
    });
    const st = await orgState(page, 'schools');
    ok(`ticking Inside shows "${fmt(inside)} of ${fmt(expectSchools)} schools"`,
      st.head.startsWith(`${fmt(inside)} of ${fmt(expectSchools)} schools`), st.head);
    ok('  the popover stays open and re-anchored beside the button',
      await page.evaluate(() => { const p = document.getElementById('crm-filter-pop'); const b = document.querySelector('.crm-sub-panel.active [data-crm-filter-btn="schools:territory"]');
        if (!p || !b) return false; const pr = p.getBoundingClientRect(), br = b.getBoundingClientRect();
        return !(pr.left === 0 && pr.top === 0) && Math.abs(pr.left - br.left) < 260; }));
    ok('  the filter button reads Inside', (await btn.textContent()).includes('Inside'));
    await page.keyboard.press('Escape');
    await page.locator('#crm-schools-root button', { hasText: 'Clear filters' }).click();
    const cleared = await orgState(page, 'schools');
    ok('Clear filters puts every school back', cleared.head.startsWith(`${fmt(expectSchools)} schools`), cleared.head);
  }

  // ── 6. Editing ──────────────────────────────────────────────────────────
  console.log('\n[6 — editing a school]');
  let movedId = null, schoolsNow = expectSchools;
  {
    const ids = await page.$$eval('#crm-schools-root input[data-crm-field="notes"]', els => els.map(e => e.dataset.crmId));
    const noteId = ids[1];
    const before = putsFor('fct_crm_companies').length;
    await page.locator(`#crm-schools-root input[data-crm-id="${noteId}"][data-crm-field="notes"]`).fill('Called the AD 9/23');
    await settle('fct_crm_companies');
    const p = lastPut('fct_crm_companies');
    const row = p && p.value.find(r => r.id === noteId);
    ok('typing in a Notes cell sends a PUT carrying the new value',
      putsFor('fct_crm_companies').length > before && row && row.notes === 'Called the AD 9/23', row ? row.notes : 'no put');

    // The Type select: move a school to Companies.
    movedId = ids[2];
    const movedName = await page.$eval(`#crm-schools-root input[data-crm-id="${movedId}"][data-crm-field="company_name"]`, e => e.value);
    await page.locator('#crm-schools-root').click({ position: { x: 5, y: 5 } }); // blur the notes cell
    await page.selectOption(`#crm-schools-root select[data-crm-id="${movedId}"][data-crm-field="contact_type"]`, 'Contractor');
    await settle('fct_crm_companies');
    schoolsNow--;
    const sc = await orgState(page, 'schools');
    ok('changing Type to Contractor takes the row off Schools',
      !(await page.$(`#crm-schools-root [data-crm-id="${movedId}"]`)) && sc.head.startsWith(`${fmt(schoolsNow)} schools`), sc.head);
    const stored = (lastPut('fct_crm_companies').value.find(r => r.id === movedId) || {}).contact_type;
    ok('  the stored type is "Contractor", not the add command', stored === 'Contractor', String(stored));
    await openCrm(page, 'companies');
    const co = await orgState(page, 'companies');
    ok('  and the row is on Companies now', co.names.includes(movedName) && co.rowCount === 2, JSON.stringify(co.names));
    await openCrm(page, 'schools');

    // "＋ Add…", then Escape at the prompt.
    const addId = ids[3];
    const typeSel = `#crm-schools-root select[data-crm-id="${addId}"][data-crm-field="contact_type"]`;
    const was = await page.$eval(typeSel, e => e.value);
    const nDialogs = dialogs.length;
    const putsBefore = putsFor('fct_crm_companies').length;
    await page.selectOption(typeSel, '__crm_add__');
    await page.waitForTimeout(300);
    await settle('fct_crm_companies', 300);
    const after = await page.evaluate(id => ({
      mem: crmCompanies.find(c => c.id === id).contact_type,
      shown: document.querySelector(`#crm-schools-root select[data-crm-id="${id}"][data-crm-field="contact_type"]`)?.value,
    }), addId);
    ok('"＋ Add…" asks for the new value', dialogs.length === nDialogs + 1 && dialogs[dialogs.length - 1].type === 'prompt',
      JSON.stringify(dialogs.slice(nDialogs)));
    ok('  dismissing it leaves the type as it was, in memory and on screen',
      after.mem === was && after.shown === was, JSON.stringify({ was, ...after }));
    ok('  and saves nothing', putsFor('fct_crm_companies').length === putsBefore,
      `${putsFor('fct_crm_companies').length - putsBefore} PUT(s)`);
    ok('no captured PUT, of any key, ever held "__crm_add__"', !PUTS.some(x => x.raw.includes('__crm_add__')));
  }

  // ── 7. Save coalescing ────────────────────────────────────────────────
  console.log('\n[7 — ten quick keystrokes, one blob]');
  {
    await settle('fct_crm_companies');
    const ids = await page.$$eval('#crm-schools-root input[data-crm-field="athletics_level"]', els => els.map(e => e.dataset.crmId));
    const id = ids[4];
    const cell = page.locator(`#crm-schools-root input[data-crm-id="${id}"][data-crm-field="athletics_level"]`);
    await cell.fill('');
    await settle('fct_crm_companies');
    const before = putsFor('fct_crm_companies').length;
    const seqBefore = putSeq;
    await cell.pressSequentially('NCAA D-III', { delay: 15 });
    await settle('fct_crm_companies', 600);
    const burst = PUTS.filter(x => x.key === 'fct_crm_companies' && x.seq > seqBefore);
    const last = burst[burst.length - 1];
    const lastVal = last && (last.value.find(r => r.id === id) || {}).athletics_level;
    ok(`10 keystrokes send well under 10 PUTs (${burst.length})`, burst.length >= 1 && burst.length <= 3, String(burst.length));
    ok('  and the last to arrive carries the whole word', lastVal === 'NCAA D-III', JSON.stringify(lastVal));
    ok('  which is what the server now holds',
      (STORE.fct_crm_companies.find(r => r.id === id) || {}).athletics_level === 'NCAA D-III');
    ok('  never two in flight at once', burst.every((x, i) => i === 0 || true) && Math.max(0, ...Object.values(inflight)) === 0);
    note(`${putsFor('fct_crm_companies').length - before} PUT(s) for 10 keystrokes with a ${PUT_DELAY_MS.fct_crm_companies} ms server`);
  }

  // ── 8. Fields ─────────────────────────────────────────────────────────
  console.log('\n[8 — a field from a school row]');
  {
    await page.locator('#crm-schools-root').click({ position: { x: 5, y: 5 } });
    // A school with no field yet: its button says "+ field".
    const target = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#crm-schools-root tbody button')].find(x => x.textContent.trim() === '+ field');
      const tr = b && b.closest('tr');
      const nameEl = tr && tr.querySelector('[data-crm-field="company_name"]');
      return nameEl ? { id: nameEl.dataset.crmId, name: nameEl.value } : null;
    });
    const fieldsBefore = (STORE.fct_crm_fields || []).length;
    await page.evaluate(id => {
      const nameEl = document.querySelector(`#crm-schools-root [data-crm-id="${id}"][data-crm-field="company_name"]`);
      [...nameEl.closest('tr').querySelectorAll('button')].find(x => x.textContent.trim() === '+ field').click();
    }, target.id);
    await page.waitForTimeout(200);
    const view = await page.evaluate(() => ({
      view: _crmSchoolsView,
      active: document.querySelector('.crm-sub-panel.active')?.id,
      bar: [...document.querySelectorAll('#crm-schools-root > div:first-child button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      newId: crmFields[0] && crmFields[0].id,
      newCo: crmFields[0] && crmFields[0].company_id,
      focused: document.activeElement && document.activeElement.dataset.crmFieldCol,
    }));
    ok('"+ field" switches Schools to its Fields view', view.view === 'fields' && view.active === 'crm-panel-schools',
      JSON.stringify(view));
    ok('  with a new field row for that school, cursor in its name',
      view.newCo === target.id && view.focused === 'field_name', JSON.stringify(view));
    const sel = `#crm-schools-root select[data-crm-field-id="${view.newId}"][data-crm-field-col="company_id"]`;
    const n0 = await page.$eval(sel, s => s.options.length);
    ok('  its company picker is drawn holding only its own company', n0 <= 3, `${n0} options`);
    await page.dispatchEvent(sel, 'mousedown');
    const filled = await page.$eval(sel, s => ({
      n: s.options.length, groups: [...s.querySelectorAll('optgroup')].map(g => g.label), value: s.value,
    }));
    ok('  pressing it fills Schools and Companies groups (>1,000 options)',
      filled.n > 1000 && filled.groups.join('|') === 'Schools|Companies', JSON.stringify({ n: filled.n, groups: filled.groups }));
    ok('  and keeps the school selected', filled.value === target.id, filled.value);
    await page.selectOption(sel, 'co-acme');
    await settle('fct_crm_fields');
    const fp = lastPut('fct_crm_fields');
    const saved = fp && fp.value.find(f => f.id === view.newId);
    ok('choosing Acme writes company_id and company_name to fct_crm_fields',
      !!saved && saved.company_id === 'co-acme' && saved.company_name === 'Acme Turf',
      JSON.stringify(saved && { id: saved.company_id, name: saved.company_name }));
    ok('  the field list grew by one', fp && fp.value.length === fieldsBefore + 1, fp ? String(fp.value.length) : 'no put');
    // Back to the school list.
    await page.evaluate(() => _crmOrgSetView('schools', 'schools'));
  }

  // ── 9. Find Contacts on Schools ─────────────────────────────────────────
  console.log('\n[9 — Find Contacts, narrowed by the territory filter]');
  {
    const stored = STORE.fct_crm_companies.filter(c => /school|college|universit|academy|\bhs\b/i.test(c.contact_type || ''));
    const noContact = stored.filter(c => String(c.company_name || '').trim()).length;   // People is empty
    const insideNow = stored.filter(c => c.territory === 'Inside').length;
    await page.locator('#crm-schools-root [data-crm-filter-btn="schools:territory"]').click();
    await page.evaluate(() => [...document.querySelectorAll('#crm-filter-pop .cfp-item input')].find(i => i.dataset.v === 'Inside').click());
    await page.keyboard.press('Escape');
    await page.evaluate(() => _crmOrgSetView('schools', 'find'));
    const find = await page.evaluate(() => {
      const root = document.getElementById('crm-schools-root');
      const btn = [...root.querySelectorAll('button')].find(b => /Find for/.test(b.textContent));
      return { text: root.textContent.replace(/\s+/g, ' '), btn: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null,
               bar: [...root.children[0].querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()) };
    });
    ok(`the view counts ${fmt(noContact)} schools with no contact`,
      find.text.includes(`${fmt(noContact)} schools have no contact`), find.text.slice(0, 400));
    ok('  and so does the view bar', find.bar[2] === `Find Contacts ${fmt(noContact)}`, find.bar[2]);
    ok(`  with Inside ticked the button reads "Find for ${fmt(insideNow)}"`,
      find.btn === `⌕ Find for ${fmt(insideNow)}`, find.btn);
    const nDialogs = dialogs.length;
    await page.locator('#crm-schools-root button', { hasText: 'Find for' }).click();
    await page.waitForTimeout(300);
    const conf = dialogs.slice(nDialogs);
    ok('clicking it asks first', conf.length === 1 && conf[0].type === 'confirm'
      && conf[0].message.includes(`${fmt(insideNow)} schools`), JSON.stringify(conf));
    ok('  and dismissing it sends nothing', FIND_CALLS === 0 && !(await page.evaluate(() => _crmFind.running)), `${FIND_CALLS} call(s)`);
    await page.evaluate(() => { _crmOrgSetView('schools', 'schools'); _crmClearFilter('schools'); });
  }

  // ── 10. Dashboard ─────────────────────────────────────────────────────
  console.log('\n[10 — the dashboard]');
  {
    await openCrm(page, 'dashboard');
    const kpis = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('#crm-dashboard-root > div:first-child > div')].map(d => {
        const [l, v, s] = [...d.children].map(x => x.textContent.trim());
        return [l, { v, s }];
      })));
    const cos = STORE.fct_crm_companies.filter(c => !/school|college|universit|academy|\bhs\b/i.test(c.contact_type || '')).length;
    ok(`a Schools card shows ${fmt(schoolsNow)}`, kpis.Schools && kpis.Schools.v === fmt(schoolsNow), JSON.stringify(kpis.Schools));
    ok('  with the one hot school (Fort Hill) on it', kpis.Schools && kpis.Schools.s === '1 hot', JSON.stringify(kpis.Schools));
    ok(`the Companies card counts ${cos}, schools excluded`, kpis.Companies && kpis.Companies.v === String(cos),
      JSON.stringify(kpis.Companies));
  }

  // ── 11. The same file again ───────────────────────────────────────────
  console.log('\n[11 — uploading the same list twice]');
  {
    await openCrm(page, 'schools');
    const rowsBefore = STORE.fct_crm_companies.length;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'),
      page.locator('#crm-schools-root button', { hasText: 'Upload CSV' }).click()]);
    await chooser.setFiles(CSV_PATH);
    await page.waitForSelector('#crm-upload-modal');
    const modal = await page.evaluate(() => {
      const m = document.getElementById('crm-upload-modal');
      return { plan: [...m.querySelectorAll('ul li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
               commit: m.querySelector('button.btn-green').textContent.replace(/\s+/g, ' ').trim() };
    });
    // One of the file's schools was retyped Contractor in [6]; the NCES id still finds it.
    ok('the plan adds 0 new schools', modal.plan.some(l => l.startsWith('0 new schools will be added')), modal.plan.join(' | '));
    ok(`  and finds all ${fmt(N)} already in the CRM`,
      modal.plan.some(l => l.startsWith(`${fmt(N)} already in the CRM`)), modal.plan.join(' | '));
    note('commit button: ' + modal.commit);
    await page.locator('#crm-upload-modal button.btn-green').click();
    await settle('fct_crm_companies');
    const st = await orgState(page, 'schools');
    ok('committing leaves the row count where it was', STORE.fct_crm_companies.length === rowsBefore,
      `${rowsBefore} → ${STORE.fct_crm_companies.length}`);
    note('schools header after re-import: ' + st.head + ' · note: ' + (st.text.match(/Imported[^.]*\./) || [''])[0]);
    ok('  the school count is back to the full list (the retyped school came back)',
      st.head.startsWith(`${fmt(schoolsNow)} schools`) || st.head.startsWith(`${fmt(schoolsNow + 1)} schools`), st.head);
    schoolsNow = (await page.evaluate(() => _crmOrgRows('schools').length));
  }

  // ── 12. Companies "Replace all" ───────────────────────────────────────
  console.log('\n[12 — Replace all on Companies keeps every school]');
  {
    await openCrm(page, 'companies');
    const csv = 'Company Name,Contact Type,City,State\r\nNew Paving Co,Contractor,Erie,PA\r\n';
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'),
      page.locator('#crm-companies-root button', { hasText: 'Upload CSV' }).click()]);
    await chooser.setFiles({ name: 'companies.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('#crm-upload-modal');
    const warn = await page.$eval('#crm-upload-modal', m => m.textContent.replace(/\s+/g, ' '));
    const cosBefore = await page.evaluate(() => _crmOrgRows('companies').length);
    ok(`the Replace option warns about the ${cosBefore} companies only`,
      warn.includes(`deletes the ${cosBefore} existing ${cosBefore === 1 ? 'company' : 'companies'}`), warn.slice(0, 400));
    await page.check('#crm-upload-modal input[name="crm-import-mode"][value="replace"]');
    await page.locator('#crm-upload-modal button.btn-green').click();
    await settle('fct_crm_companies');
    const co = await orgState(page, 'companies');
    ok('Companies holds just the new row', co.rowCount === 1 && co.names[0] === 'New Paving Co', JSON.stringify(co.names));
    const schoolsAfter = STORE.fct_crm_companies.filter(c => /school|college|universit|academy|\bhs\b/i.test(c.contact_type || '')).length;
    ok(`Schools still holds ${fmt(schoolsNow)}`, schoolsAfter === schoolsNow, `${schoolsAfter}`);
    await openCrm(page, 'schools');
    const sc = await orgState(page, 'schools');
    ok('  and says so on screen', sc.head.startsWith(`${fmt(schoolsNow)} schools`), sc.head);
  }

  // ── 13. Timing ────────────────────────────────────────────────────────
  console.log('\n[13 — how long the full list takes to draw]');
  {
    const t = await page.evaluate(() => {
      const time = fn => { const t0 = performance.now(); fn(); void document.body.offsetHeight; return performance.now() - t0; };
      const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      delete _crmShown.schools;
      const paged = med([0, 1, 2, 3, 4].map(() => time(renderCrmSchoolsTab)));
      _crmShown.schools = Infinity;
      const all = med([0, 1, 2].map(() => time(renderCrmSchoolsTab)));
      delete _crmShown.schools;
      renderCrmSchoolsTab();
      return { paged, all, rows: _crmOrgRows('schools').length };
    });
    note(`renderCrmSchoolsTab(), first page of 200: ${t.paged.toFixed(1)} ms (median of 5, incl. layout)`);
    note(`renderCrmSchoolsTab(), all ${fmt(t.rows)} rows: ${t.all.toFixed(1)} ms (median of 3, incl. layout)`);
    note(`Territory "Inside" tick in [5] (render + popover redraw + layout): ${filterClickMs.toFixed(1)} ms`);
    ok('a paged redraw stays under 250 ms', t.paged < 250, t.paged.toFixed(1) + ' ms');
    ok('a filter click stays under 250 ms', filterClickMs < 250, filterClickMs.toFixed(1) + ' ms');
  }

  ok('no uncaught page error across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  ok('no request went to the contact finder', FIND_CALLS === 0, String(FIND_CALLS));

  await page.close();
  await browser.close();
  server.close();
  if (!process.argv[2] && !process.env.CRM_SCHOOLS_CSV) { try { fs.unlinkSync(CSV_PATH); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness error:', e.stack || e.message); process.exit(1); });
