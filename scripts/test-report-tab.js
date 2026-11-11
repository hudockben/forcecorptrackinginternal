#!/usr/bin/env node
'use strict';
/**
 * Tests for dwReportTab (report-tab.js): a printed report in a tab of its own.
 *
 * Run: node scripts/test-report-tab.js
 *      xvfb-run -a node scripts/test-report-tab.js   (adds the print-dialog check)
 *
 * The bug it guards: Job Summary → Print / Save PDF opened its report with
 * window.open('') and wrote into the handle. While that report's print dialog
 * was up, the app tab answered nothing — no click, no script — until the
 * report tab was closed, because Chrome pauses every page in the browsing
 * context group while a print dialog is open, and a window this page can
 * script is in its group. dwReportTab opens the report with noopener instead
 * and hands it over by BroadcastChannel.
 *
 * Three layers:
 *   1. Structural — every page calling dwReportTab loads report-tab.js after
 *      report-branding.js, and each Job Summary claims its tab before its
 *      first await (a pop-up after an await is blocked) and opens no window
 *      of its own.
 *   2. The hand-over, in Chrome: a report built after the tab asks and one
 *      built before both arrive, branded, onload intact; a failed build says
 *      so in the tab; two tabs at once each get their own; a blocked pop-up
 *      is reported; a browser with no BroadcastChannel still gets its report.
 *   3. The bug itself: with a real print dialog open in the report tab, the
 *      app still answers — and the old window.open('') way does not, so the
 *      check is known to catch it. Needs a display (print preview does not
 *      open headless): skipped, not failed, without one.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0, skipped = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function skip(label, why) { skipped++; console.log(`  ~ ${label} (skipped: ${why})`); }

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('\nwiring — pages that open a report tab load the module');

const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const callers = htmlFiles.filter(f => /\bdwReportTab\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
assert('the Job Summary pages call dwReportTab',
  ['tracker.html', 'paving.html', 'kiewit-pinetree.html'].every(f => callers.includes(f)), callers.join(', '));
for (const f of callers) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const tab = s.indexOf('<script src="report-tab.js"');
  const brand = s.indexOf('<script src="report-branding.js"');
  assert(`${f}: loads report-tab.js, after report-branding.js`, tab > -1 && brand > -1 && tab > brand);
}

for (const f of ['tracker.html', 'paving.html', 'kiewit-pinetree.html']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const a = s.indexOf('async function exportJobSummary(projId, opts = {})');
  const fn = a < 0 ? '' : s.slice(a, s.indexOf('\nfunction exportBidPDF', a));
  assert(`${f}: Job Summary block located`, !!fn);
  const claim = fn.indexOf('dwReportTab(');
  const firstAwait = fn.search(/\bawait\b/);
  assert(`${f}: the tab is claimed before the first await`, claim > -1 && claim < firstAwait);
  assert(`${f}: the Job Summary opens no window of its own`, !/window\.open\s*\(/.test(fn));
  assert(`${f}: a failed build is shown in the tab`, /tab\.fail\(/.test(fn));
  assert(`${f}: the report still prints itself on load`,
    /<script>window\.onload = \(\) => \{ window\.print\(\); \}<\\\/script>/.test(fn));
}

const src = fs.readFileSync(path.join(ROOT, 'report-tab.js'), 'utf8');
assert('the tab is opened with noopener', /window\.open\(url, '_blank', 'noopener'\)/.test(src));

// ── 2 & 3. In Chrome ───────────────────────────────────────────────────────
function findChrome() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
                   '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(c) && fs.statSync(fs.realpathSync(c)).isFile()) return c;
  }
  return null;
}

// The app page: the two modules, as the division pages load them.
const APP = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>App</title></head><body>
  <button id="b">x</button>
  <script src="/report-branding.js"></script><script src="/report-tab.js"></script></body></html>`;
// A report as the builders write one: it prints itself on load. `marker`
// stands in for print() where the dialog is not wanted.
const report = (name, onload) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name} — Job Summary</title></head>`
  + `<body><h2>${name}</h2><script>window.onload = () => { ${onload} }<\/script></body></html>`;
const MARK = 'window.__loaded = (window.__loaded || 0) + 1;';

const within = (p, ms) => Promise.race([p.then(v => ({ ok: true, v }), e => ({ ok: false, e })),
  new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    skip('the hand-over in Chrome', 'no Chrome/Chromium on this box');
    skip('the app answers with a print dialog open', 'no Chrome/Chromium on this box');
    return;
  }
  const puppeteer = (await import('puppeteer-core')).default;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/report-branding.js' || p === '/report-tab.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(ROOT, p.slice(1))));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(APP);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // A fresh browser per case: a print dialog left open pauses what it pauses
  // until the browser goes, and no case should inherit another's tabs.
  async function withBrowser(headless, fn) {
    const browser = await puppeteer.launch({ executablePath: chrome, headless,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-popup-blocking'] });
    try {
      const app = await browser.newPage();
      await app.goto(base);
      await app.waitForFunction(() => typeof window.dwReportTab === 'function');
      return await fn(browser, app);
    } finally {
      try { browser.process() && browser.process().kill('SIGKILL'); } catch { /* gone */ }
    }
  }
  // The report tabs, as they appear. A noopener tab is its own target.
  const nextTab = (browser, n = 1) => new Promise(resolve => {
    const got = [];
    browser.on('targetcreated', async t => {
      if (t.type() !== 'page') return;
      got.push(await t.page());
      if (got.length === n) resolve(got);
    });
  });
  const readTab = tab => within(tab.evaluate(() => ({
    url: location.protocol, title: document.title, text: document.body ? document.body.innerText : '',
    loaded: window.__loaded || 0, brand: !!document.querySelector('[data-dw-brand]'),
    opener: window.opener === null ? 'none' : 'some',
  })), 5000);
  // Clicks are what grant a pop-up; the page's own click handler runs `code`.
  const clickRun = (app, code) => app.evaluate(c => {
    const b = document.getElementById('b');
    b.onclick = () => { (0, eval)(c); };
  }, code).then(() => app.click('#b'));

  try {
    console.log('\nthe hand-over');

    await withBrowser(true, async (browser, app) => {
      const tabs = nextTab(browser);
      await clickRun(app, `window.__t = dwReportTab({ title: 'Job Summary', waiting: 'Building…' });`);
      const [tab] = await tabs;
      await sleep(500);   // the tab has asked by now
      const before = await readTab(tab);
      assert('the tab opens on the waiting message', before.ok && /Building…/.test(before.v.text), JSON.stringify(before.v));
      assert('the tab is not tied to the app (noopener)', before.ok && before.v.opener === 'none');
      await app.evaluate(html => window.__t.fill(html), report('Maple Ave', MARK));
      await sleep(500);
      const r = await readTab(tab);
      assert('a report built after the tab asked arrives', r.ok && /Maple Ave/.test(r.v.text), JSON.stringify(r.v));
      assert('…titled as the report, so Save as PDF names the file from it', r.ok && r.v.title === 'Maple Ave — Job Summary');
      assert('…branded the way dwWrite brands it', r.ok && r.v.brand);
      assert('…and its onload runs once — where print() goes', r.ok && r.v.loaded === 1, r.ok && r.v.loaded);
    });

    await withBrowser(true, async (browser, app) => {
      const tabs = nextTab(browser);
      // Built in the same click, before the tab can have asked.
      await clickRun(app, `dwReportTab({ title: 'Job Summary' }).fill(${JSON.stringify(report('Oak St', MARK))});`);
      const [tab] = await tabs;
      await sleep(800);
      const r = await readTab(tab);
      assert('a report built before the tab asked waits for it, then arrives',
        r.ok && /Oak St/.test(r.v.text) && r.v.loaded === 1, JSON.stringify(r.v));
    });

    await withBrowser(true, async (browser, app) => {
      const tabs = nextTab(browser);
      await clickRun(app, `window.__t = dwReportTab({ title: 'Job Summary' });`);
      const [tab] = await tabs;
      await app.evaluate(() => window.__t.fail('The job summary could not be built: boom'));
      await sleep(600);
      const r = await readTab(tab);
      assert('a failed build says so in the tab, not "Building…" forever',
        r.ok && /could not be built: boom/.test(r.v.text) && !/Building/.test(r.v.text), JSON.stringify(r.v));
    });

    await withBrowser(true, async (browser, app) => {
      const tabs = nextTab(browser, 2);
      await clickRun(app, `window.__a = dwReportTab({}); window.__b = dwReportTab({});`);
      const [t1, t2] = await tabs;
      await sleep(500);
      await app.evaluate((a, b) => { window.__b.fill(b); window.__a.fill(a); }, report('Report A', MARK), report('Report B', MARK));
      await sleep(600);
      const texts = (await Promise.all([readTab(t1), readTab(t2)])).map(r => r.ok ? r.v.text : '');
      const a = texts.filter(t => /Report A/.test(t)).length, b = texts.filter(t => /Report B/.test(t)).length;
      assert('two tabs open at once each get their own report', a === 1 && b === 1, JSON.stringify(texts));
    });

    await withBrowser(true, async (browser, app) => {
      // A blocked pop-up: window.open hands back null and no tab appears.
      await clickRun(app, `window.open = () => null; window.__blocked = 0;
        dwReportTab({ onBlocked: () => { window.__blocked++; } });`);
      await sleep(9000);
      assert('a blocked pop-up is reported once the tab has not asked in time',
        await app.evaluate(() => window.__blocked) === 1);
    });

    await withBrowser(true, async (browser, app) => {
      const tabs = nextTab(browser);
      await clickRun(app, `delete window.BroadcastChannel; window.BroadcastChannel = undefined;
        window.__t = dwReportTab({ title: 'Job Summary' });`);
      const [tab] = await tabs;
      await app.evaluate(html => window.__t.fill(html), report('Pine Rd', MARK));
      await sleep(600);
      const r = await readTab(tab);
      assert('no BroadcastChannel: the old window still gets the report, branded',
        r.ok && /Pine Rd/.test(r.v.text) && r.v.brand && r.v.loaded === 1, JSON.stringify(r.v));
    });

    console.log('\nthe app answers while the report\'s print dialog is open');
    if (!process.env.DISPLAY) {
      skip('the app answers with a print dialog open', 'no display — run under xvfb-run');
    } else {
      const printing = report('Print Me', 'window.print();');
      const appAnswers = async (code) => withBrowser(false, async (browser, app) => {
        const tabs = nextTab(browser);
        await app.evaluate(c => { document.getElementById('b').onclick = () => { (0, eval)(c); }; }, code);
        app.click('#b').catch(() => { /* a frozen page never finishes the click */ });
        const [tab] = await tabs;
        await sleep(3000);   // report in, print dialog up
        const answered = (await within(app.evaluate(() => 1), 4000)).ok;
        const dialogUp = !(await within(tab.evaluate(() => 1), 3000)).ok;
        return { answered, dialogUp };
      });
      const now = await appAnswers(`dwReportTab({ title: 'Job Summary' }).fill(${JSON.stringify(printing)});`);
      assert('the report tab\'s print dialog is up', now.dialogUp);
      assert('the app still answers with it open', now.answered);
      const old = await appAnswers(`const w = window.open('', '_blank'); dwWrite(w, ${JSON.stringify(printing)}); w.document.close();`);
      assert('…where the old window.open(\'\') way froze it (the check catches the bug)',
        old.dialogUp && !old.answered, JSON.stringify(old));
    }
  } finally {
    server.close();
  }
})().catch(e => { failed++; console.error('  ✗ crashed:', e && e.stack || e); })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed ? 1 : 0);
  });
