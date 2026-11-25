#!/usr/bin/env node
'use strict';
/**
 * The Home tab's "how it adds up" breakdown, in a real browser.
 *
 * Run: node scripts/test-home-stage-breakdown-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *
 * On Turf and Paving every figure in the Jobs by Stage & Year sections — the
 * totals tiles and each cell of each year row — lists, on hover, the jobs it
 * was summed from, each job's share, and the arithmetic. A click or tap pins
 * the list open with every job. scripts/test-home-metrics.js checks the sums
 * behind it; this checks what reaches the screen:
 *
 *   - every figure's breakdown shows that figure, and its job rows add up to
 *     it (to the dollar per row, since each row is rounded on its own);
 *   - a Jobs figure lists exactly that many jobs, each with the date that put
 *     it in its year, and a job whose entries span years shows the split;
 *   - the hover preview stops at a dozen jobs and says how many more; pinned,
 *     it lists them all;
 *   - a job name is shown as text, never parsed as markup;
 *   - a pinned breakdown closes on ✕, Esc, a click elsewhere or a second click
 *     on its figure, and follows its figure through a redraw with the new
 *     numbers;
 *   - a tap opens it on a touch screen, where there is no hover.
 *
 * Harness traps (see test-haul-browser.js): served over HTTP, not file://, and
 * fct_division must match the page or it bounces to divisions.html.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
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

const TOKEN = 'x.y.z';
const PAGES = [
  { file: 'tracker.html', division: 'turf',   lists: 'fct_lists',
    index: 'fct_projects_index',        project: 'fct_project_' },
  { file: 'paving.html',  division: 'paving', lists: 'fct_paving_lists',
    index: 'fct_paving_projects_index', project: 'fct_paving_project_' },
];

// ── The book ────────────────────────────────────────────────────────────────
const line = (bid, co) => [{ id: 'b1', cost_code: '100', sub_code: 'Turf', quantity: 1, unit_cost: bid, unit: 'LS',
  change_orders: co ? [{ id: 'co1', qty_delta: co }] : [] }];
const job = (id, name, status, contract, bid, o = {}) => ({
  id, 'project-name': name, status, 'contract-value': contract ? String(contract) : '',
  'start-date': o.start || '', 'end-date': o.end || '', bidItems: line(bid, o.co),
});
// The name is markup on purpose: it must come out as text.
const TRICKY = 'Hempfield <b>Softball</b> & Sons';
const PROJECTS = [
  job('ip1', 'Franklin Regional Multi', 'In Progress', 2150000, 1500000),
  // Scheduled for 2026, but its first daily entry is 2025: it counts as 2025,
  // and its spend splits across both years.
  job('ip2', TRICKY, 'In Progress', 900000, 700000, { start: '2026-03-01', co: 0.1 }),
  job('aw1', 'Mt Lebanon', 'Awarded', 596600, 450000, { start: '2027-03-15', end: '2027-07-01' }),
  job('aw2', 'Moon Township', 'Awarded', 1200000, 900000),
  job('sc1', 'Seneca Valley', 'Substantially Complete', 700000, 500000),
  job('c1', 'Peters Twp Field', 'Complete', 1100000, 850000),
  // Seventeen jobs finished in 2024 — more than the hover preview lists.
  ...Array.from({ length: 16 }, (_, i) => job('old' + i, `Archive Field ${String(i + 1).padStart(2, '0')}`,
    'Complete', 100000 + i * 1000, 80000, { end: `2024-0${1 + (i % 9)}-15` })),
  job('nc1', 'No Contract Job', 'Complete', 0, 100000, { end: '2024-09-01' }),
  job('bid1', 'Bidding Job', 'Bidding', 500000, 400000),
];
const ROWS = [
  ['ip1', '2026-04-10', 200000], ['ip1', '2026-06-02', 150000],
  ['ip2', '2025-10-02', 300000], ['ip2', '2026-05-01', 100000],
  ['sc1', '2026-05-02', 300000], ['sc1', '2026-09-30', 150000],
  ['c1',  '2025-05-03', 400000], ['c1',  '2025-08-20', 420000],
].map(([pid, date, cost], i) => ({ id: 'r' + i, _projectId: pid, date, cost_code: '100', sub_code: 'Turf',
  total_cost: String(cost), labor_hours: '8', rate: '30', quantity: '1' }));

const money = s => {
  const t = String(s || '').replace(/[^0-9.\-]/g, '');
  return t === '' || t === '-' ? null : parseFloat(t);
};

async function openPage(browser, cfg, ctxOpts) {
  const ctx  = await browser.newContext(ctxOpts || { viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(({ t, division }) => {
    localStorage.setItem('fct_token', t);
    localStorage.setItem('fct_user', JSON.stringify({ id: 7, username: 'hudockben', role: 'admin',
      companyCode: 'FCT', isPlatformAdmin: true, allowedDivisions: ['turf', 'paving', 'kiewit'] }));
    localStorage.setItem('fct_division', division);
  }, { t: TOKEN, division: cfg.division });
  await page.route('**/api/**', route => {
    const req = route.request();
    const u   = new URL(req.url());
    const p   = u.pathname;
    const m   = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/daily-rows') {
      if (m !== 'GET') return json({ ok: true });
      const since = u.searchParams.get('since') || '';
      return json({ rows: ROWS.filter(r => r.date >= since).map(r => ({ ...r })), hasMore: false });
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      for (const pr of PROJECTS) if (keys.includes(cfg.project + pr.id)) values[cfg.project + pr.id] = pr;
      if (keys.includes(cfg.lists)) values[cfg.lists] = { equipment: [], employees: [], suppliers: [] };
      return json({ values });
    }
    if (p === '/api/data/' + cfg.index) return json({ value: PROJECTS.map(pr => pr.id) });
    if (p.startsWith('/api/data/')) return json({ value: null });
    return json({});
  });
  await page.goto((await BASE) + '/' + cfg.file);
  await page.waitForFunction(n => typeof projectsList !== 'undefined' && projectsList.length === n
    && getAllDailyRows().length === 8, PROJECTS.length, { timeout: 20000 });
  // Draw once more with every row in, wherever the background backfill got to.
  await page.evaluate(() => { activeTab = 'home'; renderHomeTab(); });
  await page.waitForSelector('#home-content .stage-card');
  return { ctx, page, errors };
}

// Scrolls a figure to the middle of the screen and waits out the scroll event.
async function centre(page, key) {
  await page.evaluate(k => document.querySelector(`#home-content [data-sb="${k}"]`).scrollIntoView({ block: 'center' }), key);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function run(browser, cfg) {
  console.log(`\n${cfg.file}`);
  const { ctx, page, errors } = await openPage(browser, cfg);
  const tip    = () => page.locator('.stage-tip');
  const pinned = () => page.locator('.stage-tip.pinned');
  const fig    = key => page.locator(`#home-content [data-sb="${key}"]`);
  const away   = () => page.mouse.move(5, 5);
  const close  = async () => { await page.keyboard.press('Escape'); await away(); };
  // A scroll closes the breakdown. Playwright scrolls a figure into view
  // before pointing at it, and scrolls again when the sticky tab bar covers
  // it, so a figure left at the top edge has its breakdown closed by the
  // harness's own scroll the moment it opens. Centre it first, and let that
  // scroll's event land, before pointing.
  const settle = key => centre(page, key);
  const hover  = async key => { await settle(key); await fig(key).hover(); };
  const click  = async key => { await settle(key); await fig(key).click(); };

  // ── Every figure adds up ──
  const keys = await page.$$eval('#home-content [data-sb]', els => els.map(e => e.dataset.sb));
  ok(`every figure is wired to a breakdown (${keys.length})`, keys.length > 60, keys.length);
  const bad = [];
  for (const key of keys) {
    await click(key);
    if (!(await pinned().count())) { bad.push(`${key}: did not open`); continue; }
    const r = await page.evaluate(k => {
      const a  = document.querySelector(`#home-content [data-sb="${k}"]`);
      const t  = document.querySelector('.stage-tip.pinned');
      const shown = (a.querySelector('.home-metric-value') || a).innerText.trim();
      return {
        shown,
        head:  t.querySelector('.stage-tip-fig strong').innerText.trim(),
        rows:  t.querySelectorAll('tbody tr').length,
        hl:    [...t.querySelectorAll('tbody td.hl')].map(td => td.innerText.trim()),
        total: (t.querySelector('tfoot td.hl') || {}).innerText,
      };
    }, key);
    const f = key.split('|')[2];
    // A row's Year cell lists the same jobs as its Jobs count: exactly that many.
    if (f === 'year' || f === 'jobs') {
      if (money(r.head) !== r.rows || (f === 'jobs' && money(r.shown) !== r.rows)) {
        bad.push(`${key}: ${r.rows} rows for ${r.head} / ${r.shown}`);
      }
    } else if (r.head !== r.shown) {
      bad.push(`${key}: breakdown says ${r.head}, figure says ${r.shown}`);
    } else if (['contract', 'bid', 'actual', 'variance', 'profit', 'gp'].includes(f)) {
      const vals = r.hl.map(money).filter(v => v !== null);
      const sum  = vals.reduce((s, v) => s + v, 0);
      const want = money(r.shown);
      if (want !== null && Math.abs(sum - want) > vals.length) bad.push(`${key}: rows sum to ${sum}, figure ${want}`);
      if (r.rows > 1 && r.total !== undefined && r.total.trim() !== r.shown) bad.push(`${key}: total row ${r.total} ≠ ${r.shown}`);
    }
    await close();
  }
  ok('  each shows its figure, and its job rows add up to it', !bad.length, bad.slice(0, 6).join(' | '));

  // ── The jobs and the dates behind a year ──
  await hover('ip|2025|year');
  const y25 = await tip().innerText();
  ok('hovering a year lists its jobs, each with the date that put it there',
    y25.includes('first daily entry 10/02/2025') && !(await pinned().count()), y25.slice(0, 200));
  ok('  and says every figure on the row counts each job whole', /counted whole/.test(y25));
  await away();
  ok('  the preview goes when the pointer leaves', !(await tip().count()));

  await hover('ip|2025|actual');
  const spend = await tip().innerText();
  ok('a carryover job shows how its spend splits across years',
    spend.includes('entries: 2025 $300,000 · 2026 $100,000'), spend.slice(0, 300));
  ok('  shown as text, never parsed as markup',
    spend.includes(TRICKY) && (await page.locator('.stage-tip b').count()) === 0);
  await away();

  await hover('aw||year');
  ok('a job with no dates says so', (await tip().innerText()).includes('no dates set'));
  await away();

  await hover('ip|*|bid');
  const bid = await tip().innerText();
  ok('the bid budget splits bid lines from change orders',
    /Bid Lines/i.test(bid) && /Change Orders/i.test(bid) && bid.includes('$70,000'), bid.slice(0, 300));
  ok('  and only cost figures carry the split of a job\'s entries by year', !bid.includes('entries:'));
  await away();

  await hover('ip|*|gp');
  const gp = await tip().innerText();
  ok('GP earned shows each job\'s % complete, earned share and cost to date',
    /% Complete/i.test(gp) && /Earned/i.test(gp) && /Cost to Date/i.test(gp), gp.slice(0, 200));
  await away();

  // Seventeen jobs: the preview stops at twelve, by contract, so the one with
  // none is below the cut there — its note still says it adds nothing.
  await hover('done|2024|contract');
  ok('a job with no contract is said to add nothing',
    /1 job with no contract value adds nothing to this figure/.test(await tip().innerText()));
  await click('done|2024|contract');
  const c24 = await pinned().innerText();
  ok('  and, pinned, is listed last, marked as such',
    /No Contract Job\s*no contract value — adds nothing here\s*—\s*Total/.test(c24), c24.slice(-200));
  await close();

  // ── A long list ──
  await hover('done|2024|jobs');
  const previewRows = await page.locator('.stage-tip tbody tr').count();
  const more = await page.locator('.stage-tip-more').innerText().catch(() => '');
  ok('the hover preview lists a dozen jobs and counts the rest',
    previewRows === 12 && /and 5 more/.test(more), `${previewRows} rows, "${more}"`);
  await click('done|2024|jobs');
  ok('  pinned, it lists all seventeen', (await page.locator('.stage-tip.pinned tbody tr').count()) === 17);

  // ── Closing a pinned breakdown ──
  await page.click('.stage-tip-close');
  ok('✕ closes it', !(await tip().count()));
  await click('ip|*|contract');
  await page.mouse.click(5, 300);
  ok('a click elsewhere closes it', !(await pinned().count()));
  await click('ip|*|contract');
  await fig('ip|*|contract').click();
  ok('a second click on its figure closes it', !(await pinned().count()));
  await click('ip|*|contract');
  await page.keyboard.press('Escape');
  ok('Esc closes it', !(await pinned().count()));
  await away();

  // ── A redraw under a pinned breakdown ──
  await click('ip|*|contract');
  const before = await page.locator('.stage-tip.pinned .stage-tip-fig strong').innerText();
  await page.evaluate(() => { getProj('ip1')['contract-value'] = '2250000'; renderHomeTab(); });
  const after = await page.locator('.stage-tip.pinned .stage-tip-fig strong').innerText().catch(() => '');
  ok('a redraw keeps a pinned breakdown open, with the new figure',
    before === '$3,050,000' && after === '$3,150,000', `${before} → ${after}`);
  await close();

  ok('no page errors', !errors.length, errors.join(' | '));
  await ctx.close();

  // ── A touch screen ──
  const touch = await openPage(browser, cfg, { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  await centre(touch.page, 'ip|*|actual');
  await touch.page.locator('#home-content [data-sb="ip|*|actual"]').tap();
  ok('a tap opens the breakdown where there is no hover',
    (await touch.page.locator('.stage-tip.pinned').count()) === 1);
  ok('  with no page errors', !touch.errors.length, touch.errors.join(' | '));
  await touch.ctx.close();
}

(async () => {
  const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
  try {
    for (const cfg of PAGES) await run(browser, cfg);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
