#!/usr/bin/env node
'use strict';
/**
 * Scheduled reports, in a real browser: does each page build its report when
 * nobody is there to press the button?
 *
 * Run: node scripts/test-auto-report-browser.js
 *      (skips cleanly when there is no Chrome: set CHROME_EXECUTABLE_PATH, or
 *       have Playwright's Chromium at /opt/pw-browsers)
 *
 * Manage Users → Auto Reports sends a report by opening its division page in
 * headless Chrome, signed in as the admin who scheduled it, and asking the
 * page for the report through window.dwAutoReport — which presses the page's
 * own Email button with the modal swapped for a recorder. Every link in that
 * chain is somewhere a rename breaks it silently: a page that stops
 * registering, a builder that alerts instead of returning, a boot that never
 * says it is ready. A suite that lifts functions out of the page cannot see
 * any of that, so this drives the real runner (buildInBrowser) against the
 * real pages, over HTTP, with a fake API behind them.
 *
 * It also holds the robot to its one hard rule: it only reads. Every write a
 * page attempts while the runner has it open must be refused before it
 * reaches the server.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

// Production runs chrome-headless-shell, single-process (@sparticuz/chromium's
// own flags), and some things a normal Chrome does happily crash it — a second
// browser context did, and every scheduled report with it, while this suite ran
// green on a normal Chrome. So it runs the way production does: the headless
// shell when there is one, and single-process always (CHROME_SINGLE_PROCESS=0
// to opt out).
const CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('no Chrome/Chromium on this box — skipping browser checks'); process.exit(0); }
process.env.CHROME_EXECUTABLE_PATH = CHROME;
if (process.env.CHROME_SINGLE_PROCESS == null) process.env.CHROME_SINGLE_PROCESS = '1';
console.log(`Chrome: ${CHROME}${process.env.CHROME_SINGLE_PROCESS === '1' ? ' (single-process, as in production)' : ''}`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auto-report-test-secret';
// api/lib/email.js reads these at load. The Resend SDK itself is stubbed
// below — nothing leaves the box.
process.env.RESEND_API_KEY     = process.env.RESEND_API_KEY     || 'test-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@datawatch.test';
const SENT = [];
{
  const resendPath = require.resolve('resend');
  require.cache[resendPath] = {
    id: resendPath, filename: resendPath, loaded: true, exports: {
      Resend: class { constructor() { this.emails = { send: async o => { SENT.push(o); return { data: { id: 'stub-' + SENT.length }, error: null }; } }; } },
    },
  };
}

const { buildInBrowser, runSchedule } = require(path.join(ROOT, 'api/lib/report-schedule-runner.js'));
const { launchBrowser }  = require(path.join(ROOT, 'api/lib/pdf.js'));
const { SCHEDULABLE }    = require(path.join(ROOT, 'api/lib/report-catalog.js'));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 400) : '')); }
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };
const YESTERDAY = daysAgo(1);
const LONG_AGO  = daysAgo(200);   // outside the boot's 90-day window: only the backfill brings it

function jobDivisionData(prefix, name) {
  const keyPfx = prefix === 'turf' ? 'fct_' : `fct_${prefix}_`;
  const proj = (id, pname, status, job) => ({
    id, 'project-name': pname, 'job-number': job, status,
    'start-date': daysAgo(250), 'end-date': ymd(new Date(today.getTime() + 60 * 864e5)),
    'contract-amount': 250000,
    bidItems: [
      { id: id + '-b1', cost_code: '0100', sub_code: 'Excavation', unit: 'CY', quantity: 1000, unit_cost: 12, description: 'Excavation' },
      { id: id + '-b2', cost_code: '0200', sub_code: 'Stone Base', unit: 'TON', quantity: 400, unit_cost: 30, description: 'Stone' },
    ],
  });
  const projects = [
    proj('p1', `${name} Maple Ave`, 'In Progress', '26101'),
    proj('p2', `${name} Oak St`,    'In Progress', '26102'),
    proj('p3', `${name} Done Job`,  'Complete',    '25009'),
  ];
  const store = {
    [`${keyPfx}projects_index`]: projects.map(p => p.id),
    [`${keyPfx}lists`]: { employees: [{ name: 'Sam' }], equipment: [], cost_codes: [], job_classes: [] },
  };
  projects.forEach(p => { store[`${keyPfx}project_${p.id}`] = p; });
  const rows = [];
  let n = 1;
  for (const p of projects.slice(0, 2)) {
    rows.push({ id: String(n++), _projectId: p.id, date: YESTERDAY, cost_code: '0100', sub_code: 'Excavation',
      quantity: 120, labor_hours: 32, equip_hours: 8, material_cost: 0, employee: 'Sam', job_class: 'Operator' });
    rows.push({ id: String(n++), _projectId: p.id, date: LONG_AGO, cost_code: '0100', sub_code: 'Excavation',
      quantity: 77, labor_hours: 20, equip_hours: 4, material_cost: 0, employee: 'Sam', job_class: 'Operator' });
  }
  return { store, rows, projects };
}

const DIVS = {
  turf:   jobDivisionData('turf', 'Turf'),
  paving: jobDivisionData('paving', 'Paving'),
  kiewit: jobDivisionData('kiewit', 'Kiewit'),
};

// A construction schedule for one Kiewit job and one Turf job.
const conSchedule = title => ({
  header: { heading: 'Construction Schedule', projectTitle: title, pm: 'Pat', company: '', date: '' },
  workWeek: 5,
  rows: [
    { id: 'r1', kind: 'task', name: 'Mobilize', start: daysAgo(10), end: daysAgo(5), duration: 5, pct: 100 },
    { id: 'r2', kind: 'task', name: 'Grade',    start: daysAgo(4),  end: daysAgo(-10), duration: 10, pct: 30 },
  ],
});
DIVS.turf.store['fct_conschedule_p1']          = conSchedule('Turf Maple Ave');
DIVS.kiewit.store['fct_kiewit_conschedule_p1'] = conSchedule('Kiewit Maple Ave');

const DUST_ROWS = [
  { id: 'd1', date: YESTERDAY, company: 'Acme Paving', location: 'Pit 2', start_time: '07:00', end_time: '15:00',
    vehicle1: 'T-1', gallons: 1200 },
  { id: 'd2', date: daysAgo(40), company: 'Old Co', location: 'Pit 9', start_time: '07:00', end_time: '09:00',
    vehicle1: 'T-2', gallons: 300 },
];

// Payroll: timesheet entries for last week and this week, on the office's
// calendar (the page reads its ranges in the schedule's zone).
const NY_TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const nyDay = n => { const d = new Date(NY_TODAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const NY_MON = nyDay(-((new Date(NY_TODAY + 'T12:00:00Z').getUTCDay() + 6) % 7));   // this week's Monday
const weekDay = (weekOffset, i) => { const d = new Date(NY_MON + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + weekOffset * 7 + i); return d.toISOString().slice(0, 10); };
const LAST_MON = weekDay(-1, 0), LAST_SUN = weekDay(-1, 6);
const entry = (id, username, work_date, hours, status, division, job_id, job_label) => ({
  id, username, entry_type: 'daily', work_date, status, division, job_id, job_label,
  computed_hours: hours, travel_hours: 0, travel_to_site_hours: 0, travel_to_shop_hours: 0,
  prevailing_wage: false, haul_type: null, haul_hours: 0, haul_off_site_hours: 0,
  supervisor_name: 'Pat', start_time: '07:00', end_time: '16:30', lunch_break: 0.5, operated_equipment: [],
});
let PAYROLL_ENTRIES = [];
for (let i = 0; i < 5; i++) PAYROLL_ENTRIES.push(entry('s' + i, 'sam', weekDay(-1, i), 9, 'approved', 'turf', 'j1', 'Maple Ave'));
for (let i = 0; i < 4; i++) PAYROLL_ENTRIES.push(entry('d' + i, 'dale', weekDay(-1, i), 8, 'submitted', 'paving', 'j2', 'Route 30'));
for (let i = 0; i < 3; i++) PAYROLL_ENTRIES.push(entry('t' + i, 'sam', weekDay(0, i), 10, 'submitted', 'turf', 'j1', 'Maple Ave'));
const ALL_PAYROLL = PAYROLL_ENTRIES.slice();

// Safety Center: forms filed by week (their Monday), who signed each — with
// the mark they drew, which the server hands out only on a one-document read
// — and who on the roster has not. Marks are drawn in the browser below.
const THIS_MON = weekDay(0, 0), TWO_MON = weekDay(-2, 0);
const STATEMENT = 'I have read this document in full, I understand its contents, and I agree to follow the safety requirements it describes.';
let SAFETY_DOCS = [];
let SAFETY_DENY = false;
const safetyDoc = (id, title, weekOf, signed, outstanding, archivedAt) => ({
  document: { id, title, weekOf, filename: id + '.pdf', uploadedBy: 'sue', uploadedAt: weekOf + 'T12:00:00Z', archivedAt: archivedAt || null },
  signed, outstanding: outstanding.map((u, i) => ({ userId: 100 + i, username: u, level: 'level1' })),
});
const signer = (userId, username, fullName, signedAt, signatureImage) =>
  ({ userId, username, fullName, signedAt, statement: STATEMENT, signatureImage: signatureImage || null });
function safetyGroup(g, withImages) {
  const signed = g.signed.map(s => {
    const o = { userId: s.userId, username: s.username, fullName: s.fullName, signedAt: s.signedAt, statement: s.statement,
      hasDrawnSignature: Boolean(s.signatureImage), onRoster: true };
    if (withImages && s.signatureImage) o.signatureImage = s.signatureImage;
    return o;
  });
  const expected = signed.length + g.outstanding.length;
  return { document: g.document, expectedCount: expected, signedCount: signed.length, outstandingCount: g.outstanding.length,
    percentSigned: expected ? Math.round(signed.length / expected * 100) : 0, signed, outstanding: g.outstanding };
}

const STORE = Object.assign({}, DIVS.turf.store, DIVS.paving.store, DIVS.kiewit.store, {
  fct_trucking_schedule: { assignments: { [YESTERDAY]: [
    { id: 'a1', driver: 'Dale', customer: 'Acme Paving', unit: 'T-14', start: '06:30', notes: 'Stone to Maple Ave' },
  ] } },
  fct_trucking_labor_schedule: { assignments: {} },
});

// ── A fake API over the real pages ──────────────────────────────────────────
const writes = [];   // every non-read request that reached the server
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function divisionOf(u) { return u.searchParams.get('division') || 'turf'; }

// Reads to fail on purpose (a path, or a /api/data key), to see a failed load
// reported as a failure rather than emailed as an empty report.
const FAIL = new Set();
// The AI's answer time per job id, to see one slow answer not sink a run.
const AI_DELAY = {};
// Every request that carried the deployment-protection bypass header.
const BYPASS_SEEN = { app: 0, other: 0 };
// Paths that are never answered, to see what a stuck page reports.
const HANG = new Set();
// Every app path the pages asked for, to see what the robot's page reads.
const ASKED = [];
// AI reads in flight at once, and the most there ever were.
const AI_SEEN = { live: 0, max: 0, pids: [] };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (req.headers['x-vercel-protection-bypass']) BYPASS_SEEN.app++;
  if (p.startsWith('/api/')) ASKED.push(req.method + ' ' + req.url);
  if (HANG.has(p)) return;
  if (FAIL.has(p) || (p.startsWith('/api/data/') && FAIL.has(p.slice('/api/data/'.length)))) {
    return json(res, { error: 'Database is down' }, 503);
  }
  // A deployment behind Vercel's login: the page sends the robot to sign in.
  if (p === '/__fixture/protected.html') {
    res.writeHead(307, { Location: `https://vercel.com/sso-api?url=${encodeURIComponent('http://app' + req.url)}` });
    return res.end();
  }
  // The same, but the login page redirects in script rather than by HTTP.
  if (p === '/__fixture/script-login.html') {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><script>location.href = "https://vercel.com/sso-api?url=x";</script>');
  }
  // Some other sign-in, on another host, with /sso in its path.
  if (p === '/__fixture/other-sso.html') {
    res.writeHead(302, { Location: `${OTHER_ORIGIN}/sso/start` });
    return res.end();
  }
  // The app's address given as http where the site lives on https.
  if (p === '/__fixture/to-https.html') {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    return res.end();
  }
  if (p === '/__fixture/denied.html') {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Authentication Required</title>');
  }
  // A page of the app's own that pulls a script from another origin.
  if (p === '/__fixture/bypass.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><script src="/auto-report.js"></script>
      <script src="${OTHER_ORIGIN}/lib.js"></script>
      <script>dwAutoReport.register('fixture', async () => {
        await fetch('/api/data/fct_lists');
        return { html: '<p>fixture</p>', subject: 'Fixture' };
      });</script>`);
  }
  if (p.startsWith('/api/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && p !== '/api/ai/schedule-analysis') {
      writes.push(req.method + ' ' + p);
      return json(res, { ok: true });
    }
    if (!/^Bearer .+\..+\..+/.test(String(req.headers.authorization || ''))) return json(res, { error: 'Unauthorized' }, 401);
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
      return json(res, { values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
    }
    if (p === '/api/data/_keys') return json(res, { keys: [] });
    if (p.startsWith('/api/data/')) {
      const key = p.slice('/api/data/'.length);
      return json(res, { value: key in STORE ? STORE[key] : null });
    }
    if (p === '/api/daily-rows') {
      const d = DIVS[divisionOf(u)];
      const since = u.searchParams.get('since');
      const rows = (d ? d.rows : []).filter(r => !since || r.date >= since);
      return json(res, { rows, hasMore: false });
    }
    if (p === '/api/purchase-orders') return json(res, { purchaseOrders: [] });
    if (p === '/api/trucking')        return json(res, { truckingEntries: [] });
    if (p === '/api/deadlines')       return json(res, { deadlines: [] });
    if (p === '/api/ai/schedule-analysis') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let pid = '';
        try { pid = JSON.parse(body).projectId; } catch {}
        AI_SEEN.live++;
        AI_SEEN.pids.push(pid);
        AI_SEEN.max = Math.max(AI_SEEN.max, AI_SEEN.live);
        setTimeout(() => {
          AI_SEEN.live--;
          json(res, { summary: 'Excavation is pacing ahead of plan.', recommendations: [], outlook: 'on-track' });
        }, AI_DELAY[pid] || 0);
      });
      return;
    }
    if (p === '/api/dust-rows')   return json(res, { dustRows: DUST_ROWS });
    if (p === '/api/dust-config') return json(res, { settings: { ub_rate: 0 }, lists: { companies: [] } });
    if (p === '/api/timesheet-entries') {
      const from = u.searchParams.get('from') || '0000', to = u.searchParams.get('to') || '9999';
      const inRange = PAYROLL_ENTRIES.filter(e => e.work_date >= from && e.work_date <= to);
      if (u.searchParams.get('action') === 'pending_span') {
        return json(res, { total: 0, before: 0, after: 0, oldest: null, newest: null, oldestSince: null });
      }
      return json(res, { entries: inRange });
    }
    if (p === '/api/timesheet-supervisors') return json(res, { supervisors: [{ name: 'Pat' }] });
    if (p === '/api/safety-documents') {
      return json(res, { documents: SAFETY_DOCS.map(g => g.document), statement: STATEMENT, storageConfigured: true,
        permissions: { canView: true, canManage: true } });
    }
    if (p === '/api/safety-signatures') {
      if (SAFETY_DENY) return json(res, { error: 'Only a safety supervisor can read the sign-off report' }, 403);
      const id = u.searchParams.get('documentId');
      if (id) {
        const g = SAFETY_DOCS.find(x => x.document.id === id);
        return g ? json(res, { documents: [safetyGroup(g, true)], statement: STATEMENT }) : json(res, { error: 'Document not found' }, 404);
      }
      const from = u.searchParams.get('from') || '0000', to = u.searchParams.get('to') || '9999';
      const archived = u.searchParams.get('include') === 'archived';
      return json(res, { statement: STATEMENT, roster: [], documents: SAFETY_DOCS
        .filter(g => g.document.weekOf >= from && g.document.weekOf <= to && (archived || !g.document.archivedAt))
        .sort((a, b) => b.document.weekOf.localeCompare(a.document.weekOf))
        .map(g => safetyGroup(g, false)) });
    }
    if (p === '/api/executive/report') {
      return json(res, { ok: true, generatedAt: new Date().toISOString(), portfolios: [],
        safety: { key: 'safety', name: 'Safety Sign-Off', accent: '#f59e0b', weekOf: YESTERDAY, documents: [] } });
    }
    return json(res, {});
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

// Another origin, standing in for a CDN.
let OTHER_ORIGIN = '';
const other = http.createServer((req, res) => {
  if (req.headers['x-vercel-protection-bypass']) BYPASS_SEEN.other++;
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end('window.__cdn = 1;');
});

const ACCT = {
  userId: 7, username: 'robot-admin', companyCode: 'FCT', companyName: 'Force Corp',
  role: 'admin', isPlatformAdmin: true, allowedDivisions: [],
  divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin', dust: 'admin', quarry: 'admin', payroll: 'admin',
    trucking: 'admin', scheduler: 'admin', executive: 'admin', safety: 'level3' },
};

async function build(browser, baseUrl, type, extra = {}) {
  const def = SCHEDULABLE[type];
  const spec = Object.assign({ type, projectId: null, options: {}, timezone: 'America/New_York', today: ymd(today) }, extra);
  writes.length = 0;
  try {
    const out = await buildInBrowser(browser, { baseUrl, def, acct: ACCT, spec });
    return { out, writes: writes.slice() };
  } catch (err) {
    return { error: err.message, writes: writes.slice() };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const has = (item, s) => Boolean(item && typeof item.html === 'string' && item.html.includes(s));

// A signature as the pad saves one: a w × h PNG off a canvas, the way a
// phone's screen draws it. `noisy` fills it with noise that will not
// compress, to see what happens when the marks are too big for one email.
async function drawMark(browser, w, h, noisy) {
  const pg = await browser.newPage();
  try {
    return await pg.evaluate((w, h, noisy) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.lineWidth = Math.max(2, h / 50); x.strokeStyle = '#0f172a'; x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath();
      for (let i = 0; i <= 60; i++) {
        const px = w * 0.06 + i * w * 0.88 / 60, py = h / 2 + Math.sin(i * 0.7) * h * 0.28 + Math.cos(i * 2.3) * h * 0.08;
        if (i) x.lineTo(px, py); else x.moveTo(px, py);
      }
      x.stroke();
      if (noisy) {
        const d = x.getImageData(0, 0, w, h);
        let seed = 7;
        // The LCG's high bits: its low ones repeat every 256 and compress.
        for (let i = 0; i < d.data.length; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          d.data[i] = i % 4 === 3 ? 255 : (seed >>> 16) & 255;
        }
        x.putImageData(d, 0, 0);
      }
      return c.toDataURL('image/png');
    }, w, h, noisy);
  } finally { await pg.close(); }
}
// Width × height of a PNG data URL, from its IHDR.
function pngSize(dataUrl) {
  const b = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
  return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  OTHER_ORIGIN = 'http://127.0.0.1:' + other.address().port;
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  try {
    for (const [div, label] of (process.env.ONLY_OTHERS ? [] : [['turf', 'Turf'], ['paving', 'Paving'], ['kiewit', 'Kiewit']])) {
      console.log(`\n${label} — ${SCHEDULABLE[div + '_daily_pm'].page}`);

      let r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: '*' });
      ok('Daily PM builds for every In Progress job and only those', !r.error && r.out.items.length === 2,
        r.error || JSON.stringify(r.out.items.map(i => i.projectName)) + ' ' + JSON.stringify(r.out.errors));
      const pm = r.out && r.out.items[0];
      ok('…as the button would: subject, job and the plan itself',
        pm && /^Daily PM Report — .*Maple Ave/.test(pm.subject) && pm.projectId === 'p1' && has(pm, 'Daily Field Plan'),
        pm && pm.subject);
      ok('…with a job that has production logged (the pace line used to throw)', has(pm, '/day avg'));
      ok('…with the AI read of the job', has(pm, 'Excavation is pacing ahead of plan.'));
      ok('…stamped with the DataWatch header', has(pm, 'data-dw-brand'));
      ok('…and no print bootstrap left in it', pm && !/window\.print/.test(pm.html));
      ok('the robot never wrote anything', r.writes.length === 0, r.writes.join(', '));

      r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: 'p3', projectName: `${label} Done Job` });
      ok('a job named outright is built even when it is not In Progress',
        !r.error && r.out.items.length === 1 && r.out.items[0].projectId === 'p3', r.error || JSON.stringify(r.out.errors));

      r = await build(browser, baseUrl, `${div}_daily_pm`, { projectId: 'gone', projectName: 'Deleted Job' });
      ok('a job that no longer exists is an error, not a silent skip',
        !r.error && r.out.items.length === 0 && r.out.errors.length === 1 && /Deleted Job/.test(r.out.errors[0].error),
        r.error || JSON.stringify(r.out));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: YESTERDAY, end: YESTERDAY });
      const ds = r.out && r.out.items[0];
      ok('Daily Summary for every job, one report', !r.error && r.out.items.length === 1 && has(ds, 'Maple Ave') && has(ds, 'Oak St'),
        r.error || JSON.stringify(r.out && (r.out.skipped || r.out.errors)));
      ok('…with key figures for the email body', ds && Array.isArray(ds.summary) && ds.summary.length >= 2,
        ds && JSON.stringify(ds.summary));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: daysAgo(3), end: daysAgo(2) });
      ok('a period with no entries is skipped with the page\'s own reason',
        !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No production data/i.test(r.out.skipped[0].why),
        r.error || JSON.stringify(r.out));

      r = await build(browser, baseUrl, `${div}_daily_summary`, { projectId: null, start: daysAgo(250), end: YESTERDAY });
      ok('rows older than 90 days are in it (the backfill was waited for)',
        !r.error && r.out.items.length === 1 && /197/.test(r.out.items[0].html),
        r.error || 'quantity 120+77 not found');

      r = await build(browser, baseUrl, `${div}_bid_items`, { projectId: 'p1' });
      const bid = r.out && r.out.items[0];
      ok('Bid Line Items vs Actuals builds for the job, every cost code',
        !r.error && r.out.items.length === 1 && /^Bid Line Items vs Actuals — .*Maple Ave \(26101\)$/.test(bid.subject)
          && has(bid, '0100') && has(bid, '0200'),
        r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));

      r = await build(browser, baseUrl, `${div}_job_summary`, { projectId: 'p2' });
      const js = r.out && r.out.items[0];
      ok('Job Summary builds for the job', !r.error && r.out.items.length === 1 && /^Job Summary — .*Oak St/.test(js.subject),
        r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));

      if (SCHEDULABLE[`${div}_construction_schedule`]) {
        r = await build(browser, baseUrl, `${div}_construction_schedule`, { projectId: '*' });
        ok('Construction Schedule: the job with one is built, the job without one is skipped',
          !r.error && r.out.items.length === 1 && r.out.skipped.length === 1 && r.out.items[0].projectId === 'p1',
          r.error || JSON.stringify({ items: r.out.items.map(i => i.subject), skipped: r.out.skipped, errors: r.out.errors }));
        const cs = r.out && r.out.items[0];
        ok('…with its Gantt attached as an inline image',
          cs && cs.attachments.length === 1 && cs.attachments[0].contentId === 'cs-gantt' && has(cs, 'cid:cs-gantt'),
          cs && JSON.stringify(cs.attachments.map(a => a.filename)));
        ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));
      }
    }

    console.log('\nOne run leaves nothing for the next');
    {
      const probe = await browser.newPage();
      await probe.goto(baseUrl + '/nothing-here.html').catch(() => {});
      const keys = await probe.evaluate(() => Object.keys(localStorage)).catch(err => ['error: ' + err.message]);
      await probe.close();
      ok('the app\'s storage is empty after a run — no token, no cached jobs', keys.length === 0, JSON.stringify(keys));
    }

    console.log('\nDust Control — dust.html');
    let r = await build(browser, baseUrl, 'dust_tracking_summary', { start: daysAgo(7), end: YESTERDAY });
    const dust = r.out && r.out.items[0];
    ok('the tracking report builds for the period, all customers',
      !r.error && r.out.items.length === 1 && has(dust, 'Acme Paving') && !has(dust, 'Old Co'),
      r.error || JSON.stringify(r.out));
    ok('…and its subject says which period', dust && dust.subject === `Dust Control Tracking Report — All Customers — ${daysAgo(7)} to ${YESTERDAY}`,
      dust && dust.subject);
    ok('…and the unload flush never reached the server', r.writes.length === 0, r.writes.join(', '));
    r = await build(browser, baseUrl, 'dust_tracking_summary', { start: daysAgo(3), end: daysAgo(2) });
    ok('an empty period is skipped, not sent', !r.error && r.out.items.length === 0 && r.out.skipped.length === 1,
      r.error || JSON.stringify(r.out));

    console.log('\nQuarry — quarry.html');
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    ok('with no quarry data the break-even is skipped with the page\'s reason',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No quarry data/i.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));
    STORE.fct_quarry_sales = [{ id: 's1', date: YESTERDAY, location: 'Pit 2', product: '2A Modified', tons: 400, price: 14, total: 5600 }];
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    ok('with a sale on the books it builds', !r.error && r.out.items.length === 1 && /^Quarry Break-Even — /.test(r.out.items[0].subject),
      r.error || JSON.stringify(r.out));
    delete STORE.fct_quarry_sales;

    console.log('\nExecutive — executive.html');
    r = await build(browser, baseUrl, 'executive');
    ok('the executive report builds, every section', !r.error && r.out.items.length === 1 && /^Executive Report/.test(r.out.items[0].subject),
      r.error || JSON.stringify(r.out));

    console.log('\nScheduler — scheduler.html');
    r = await build(browser, baseUrl, 'scheduler_dispatch', { day: YESTERDAY });
    ok('the crew dispatch for a day with nothing on it is skipped',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /Nothing scheduled/.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));

    console.log('\nTrucking — trucking.html');
    r = await build(browser, baseUrl, 'trucking_dispatch', { day: YESTERDAY });
    const td = r.out && r.out.items[0];
    ok('the trucking dispatch builds for the day asked for', !r.error && r.out.items.length === 1 && has(td, 'Dale') && /^Trucking Dispatch — /.test(td.subject),
      r.error || JSON.stringify(r.out));
    r = await build(browser, baseUrl, 'trucking_labor_dispatch', { day: YESTERDAY });
    ok('the labor board, empty that day, is skipped', !r.error && r.out.items.length === 0 && r.out.skipped.length === 1,
      r.error || JSON.stringify(r.out));
    ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));

    console.log('\nPayroll — payroll.html');
    const LAST_WEEK_WORDS = (() => {
      const a = new Date(LAST_MON + 'T00:00:00'), b = new Date(LAST_SUN + 'T00:00:00');
      const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (a.getFullYear() !== b.getFullYear()) return `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
      if (a.getMonth() === b.getMonth()) return `${md(a)}–${b.getDate()}, ${b.getFullYear()}`;
      return `${md(a)} – ${md(b)}, ${b.getFullYear()}`;
    })();
    const fig = (item, label) => ((item && item.summary || []).find(x => x.label === label) || {});
    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'last_week' } });
    const ph = r.out && r.out.items[0];
    ok('Payroll Hours for last week builds, everybody on it',
      !r.error && r.out.items.length === 1 && has(ph, '>sam<') && has(ph, '>dale<') && !has(ph, 'Maple Ave'),
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));
    ok('…with the week in its subject', ph && ph.subject === `Payroll Hours Report — ${LAST_WEEK_WORDS}`, ph && ph.subject);
    ok('…and the key figures: 2 men, 5 h overtime, 32 h pending',
      fig(ph, 'Employees').value === '2' && fig(ph, 'Overtime').value === '5.00' && fig(ph, 'Overtime').tone === 'bad'
        && fig(ph, 'Pending').value === '32.00', JSON.stringify(ph && ph.summary));
    ok('…as Print makes it: the page\'s landscape @page, no buttons, no unopened detail',
      has(ph, 'size: landscape') && !has(ph, 'Export to Excel') && !has(ph, 'report-detail" data-user') && !/<button/.test(ph.html),
      ph && ph.html.length);
    ok('…one DataWatch mark, not two', ph && (ph.html.match(/data-dw-brand/g) || []).length === 1);
    ok('…and no arrow the server\'s font cannot draw', ph && !ph.html.includes('→'));
    ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));

    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'current_week' } });
    ok('this week so far is this week\'s hours only',
      !r.error && r.out.items.length === 1 && fig(r.out.items[0], 'Employees').value === '1' && fig(r.out.items[0], 'Hours Worked').value === '30.00',
      r.error || JSON.stringify(r.out.items[0] && r.out.items[0].summary));

    r = await build(browser, baseUrl, 'payroll_projects', { options: { range: 'last_week' } });
    const pp = r.out && r.out.items[0];
    ok('the Project Overtime Report builds, both jobs on it',
      !r.error && r.out.items.length === 1 && has(pp, 'Maple Ave') && has(pp, 'Route 30')
        && pp.subject === `Project Overtime Report — ${LAST_WEEK_WORDS}`,
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped || pp.subject)));
    ok('…with the PDF ticks Print defaults to: no summary cards, the board and the job tables in',
      pp && !has(pp, 'class="proj-stats') && has(pp, 'data-piece="crew"') && has(pp, 'data-piece="tables"'));
    const blocks = pp ? (pp.html.match(/class="proj-block(?: [^"]*)?"/g) || []) : [];
    ok('…every job opened and the whole crew shown',
      pp && !/class="[^"]*\bcc-collapsed\b/.test(pp.html) && /class="cc-board/.test(pp.html)
        && blocks.length === 2 && blocks.every(c => /\bopen\b/.test(c)),
      JSON.stringify({ blocks }));
    ok('…and its key figures', fig(pp, 'Jobs Worked').value === '2' && fig(pp, 'Men Past 40').value === '1', JSON.stringify(pp && pp.summary));

    r = await build(browser, baseUrl, 'payroll_overtime', {});
    const po = r.out && r.out.items[0];
    ok('Weekly Overtime builds for the week in progress',
      !r.error && r.out.items.length === 1 && /^Weekly Overtime — .* \(so far, as of /.test(po.subject) && has(po, '>sam<'),
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped || po.subject)));
    ok('…with where everybody stands', fig(po, 'Employees').value === '1' && fig(po, 'Hours Worked').value === '30.00', JSON.stringify(po && po.summary));

    PAYROLL_ENTRIES = [];
    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'last_week' } });
    ok('a week with no time on it is skipped, not sent empty',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1 && /No timesheet entries for/.test(r.out.skipped[0].why),
      r.error || JSON.stringify(r.out));
    r = await build(browser, baseUrl, 'payroll_overtime', {});
    ok('…and so is a week nobody has submitted to yet', !r.error && r.out.items.length === 0 && /No time has been submitted/.test((r.out.skipped[0] || {}).why),
      r.error || JSON.stringify(r.out));
    PAYROLL_ENTRIES = ALL_PAYROLL.slice();

    console.log('\nSafety Center — safety.html');
    // The page's own date words (dayLabel), in the robot's en-US Chrome.
    const dayWords = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const MARK  = await drawMark(browser, 1500, 600, false);   // a phone's pad at 3× — what the server stores
    const NOISE = await drawMark(browser, 480, 100, true);     // already sheet-sized, and will not compress
    const SAFETY_WEEKS = [
      safetyDoc('sd1', 'Trenching & Excavation', LAST_MON, [
        signer(1, 'jlee', 'Jordan Lee', LAST_MON + 'T13:05:00Z', MARK),
        signer(2, 'mruiz', 'Maria Ruiz', weekDay(-1, 1) + 'T14:30:00Z', null),
      ], ['tcole']),
      safetyDoc('sd2', 'Heat Illness Prevention', TWO_MON, [signer(1, 'jlee', 'Jordan Lee', TWO_MON + 'T13:00:00Z', MARK)], []),
      safetyDoc('sd3', 'Ladder Safety', THIS_MON, [], ['jlee', 'mruiz', 'tcole']),
      // Signed by everyone and archived — how a supervisor closes out a week.
      safetyDoc('sd4', 'Silica Exposure', weekDay(-3, 0), [signer(1, 'jlee', 'Jordan Lee', weekDay(-3, 0) + 'T13:00:00Z', MARK)], [],
        weekDay(-3, 4) + 'T20:00:00Z'),
    ];
    SAFETY_DOCS = SAFETY_WEEKS.slice();
    ASKED.length = 0;
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    const ss = r.out && r.out.items[0];
    ok('the sign-off report for last week builds: its one form, who signed it and who has not',
      !r.error && r.out.items.length === 1 && has(ss, 'Trenching &amp; Excavation') && has(ss, 'Jordan Lee') && has(ss, 'Maria Ruiz')
        && has(ss, '<li>tcole</li>') && !has(ss, 'Heat Illness') && !has(ss, 'Ladder Safety'),
      r.error || JSON.stringify(r.out && (r.out.errors || r.out.skipped)));
    ok('…read for those weeks, the way From week / To week read them, archived forms included',
      ASKED.some(a => a.endsWith(`/api/safety-signatures?scope=report&from=${LAST_MON}&to=${LAST_MON}&include=archived`)),
      ASKED.filter(a => /safety/.test(a)).join(' | '));
    ok('…each form read again on its own, for the marks', ASKED.some(a => a.endsWith('/api/safety-signatures?documentId=sd1')));
    ok('…with the week in its subject', ss && ss.subject === `Safety Sign-Off Report — Week of ${dayWords(LAST_MON)}`, ss && ss.subject);
    const marks = ss ? [...ss.html.matchAll(/<img src="(data:image\/png;base64,[^"]+)"/g)].map(m => m[1]) : [];
    const msize = marks[0] ? pngSize(marks[0]) : null;
    ok('…with the drawn mark, made the size the sheet prints it',
      marks.length === 1 && msize && msize.h <= 108 && msize.w <= 500 && marks[0].length < MARK.length / 2,
      JSON.stringify({ n: marks.length, msize, len: marks[0] && marks[0].length, was: MARK.length }));
    ok('…and the signer who typed their name said so in words', has(ss, 'Signed by typed name — no mark drawn'));
    ok('…as Print all makes it, less the Print bar and the print dialog',
      has(ss, 'Safety sign-off sheet') && has(ss, 'Not signed (1)') && has(ss, STATEMENT)
        && !has(ss, 'Print / Save as PDF') && !/window\.print/.test(ss.html));
    ok('…on the office clock', ss && /\bE[DS]T\b/.test(ss.html));
    ok('…printed by Auto Reports for the supervisor it runs as', has(ss, 'by Auto Reports for robot-admin'));
    ok('…one DataWatch mark', ss && (ss.html.match(/data-dw-brand/g) || []).length === 1);
    ok('…and its key figures', fig(ss, 'Form').value === 'Trenching & Excavation' && fig(ss, 'Signed').value === '2'
      && fig(ss, 'Not Signed').value === '1' && fig(ss, 'Not Signed').tone === 'bad', JSON.stringify(ss && ss.summary));
    ok('…and nothing written', r.writes.length === 0, r.writes.join(', '));

    r = await build(browser, baseUrl, 'safety_signoff', { start: TWO_MON, end: weekDay(0, 2) });
    const sm = r.out && r.out.items[0];
    const at = t => (sm ? sm.html.indexOf('<h1>' + t) : -1);
    ok('three weeks: a contents page, then every form, oldest first',
      !r.error && r.out.items.length === 1 && has(sm, 'Safety sign-off report')
        && at('Heat Illness') > 0 && at('Heat Illness') < at('Trenching') && at('Trenching') < at('Ladder Safety'),
      r.error || JSON.stringify({ h: at('Heat Illness'), t: at('Trenching'), l: at('Ladder Safety') }));
    ok('…a form nobody has signed yet is on it, with who owes it', has(sm, 'Nobody has signed this document.') && has(sm, 'Not signed (3)'));
    ok('…with the weeks in its subject', sm && sm.subject === `Safety Sign-Off Report — Weeks of ${dayWords(TWO_MON)} – ${dayWords(THIS_MON)}`,
      sm && sm.subject);
    ok('…and the figures across them', fig(sm, 'Forms').value === '3' && fig(sm, 'Signatures').value === '3'
      && fig(sm, 'Fully Signed').value === '1 of 3' && fig(sm, 'Short of Signatures').value === '2' && fig(sm, 'Short of Signatures').tone === 'bad',
      JSON.stringify(sm && sm.summary));

    r = await build(browser, baseUrl, 'safety_signoff', { start: weekDay(-3, 0), end: weekDay(-3, 6) });
    ok('a week whose form was signed and archived still goes out, with that form',
      !r.error && r.out.items.length === 1 && has(r.out.items[0], 'Silica Exposure') && has(r.out.items[0], 'Jordan Lee'),
      r.error || JSON.stringify(r.out && (r.out.skipped || r.out.errors)));

    r = await build(browser, baseUrl, 'safety_signoff', { start: weekDay(-6, 0), end: weekDay(-6, 6) });
    ok('a week with no form posted is skipped, not sent',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 1
        && r.out.skipped[0].why === `No safety forms were posted for the week of ${dayWords(weekDay(-6, 0))}.`,
      r.error || JSON.stringify(r.out));

    FAIL.add('/api/safety-signatures');
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    FAIL.clear();
    ok('a report that could not be read fails, rather than "no forms posted"',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 0
        && /sign-off report did not load — Database is down/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    SAFETY_DENY = true;
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    SAFETY_DENY = false;
    ok('…and so does one the server will not give this account',
      !r.error && r.out.items.length === 0 && /Only a safety supervisor/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));

    const crewOf = (n, mark) => [safetyDoc('sd9', 'Confined Spaces', LAST_MON,
      Array.from({ length: n }, (_, i) => signer(10 + i, 'crew' + i, 'Crew Member ' + i, LAST_MON + 'T13:00:00Z', mark)), [])];
    // A real mark is ~18 KB at twice sheet size and ~7 KB at sheet size, so a
    // hundred of them fit only at the second.
    SAFETY_DOCS = crewOf(100, MARK);
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    const mid = r.out && r.out.items[0];
    const midMarks = mid ? [...mid.html.matchAll(/<img src="(data:image\/png;base64,[^"]+)"/g)].map(m => pngSize(m[1])) : [];
    ok('marks too big for one email at twice sheet size go at sheet size instead',
      !r.error && r.out.items.length === 1 && Buffer.byteLength(mid.html) < 1500000 && midMarks.length === 100
        && midMarks.every(z => z && z.w <= 250 && z.h <= 54) && !has(mid, 'left out of this emailed copy'),
      r.error || JSON.stringify({ bytes: mid && Buffer.byteLength(mid.html), n: midMarks.length, first: midMarks[0] }));
    // Noise barely shrinks: thirty of these are too much at either size.
    SAFETY_DOCS = crewOf(30, NOISE);
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    const big = r.out && r.out.items[0];
    ok('too big even at that: it still goes, without the marks, and says so',
      !r.error && r.out.items.length === 1 && Buffer.byteLength(big.html) < 1500000 && !/<img src="data:image\/png/.test(big.html)
        && (big.html.match(/Drawn signature on file/g) || []).length === 30 && has(big, 'left out of this emailed copy'),
      r.error || JSON.stringify({ bytes: big && Buffer.byteLength(big.html), errs: r.out && r.out.errors }));
    SAFETY_DOCS = [safetyDoc('sd8', 'Tailgate Safety Meeting — Trenching & Excavation, Competent Person Daily Inspection', LAST_MON,
      [signer(1, 'jlee', 'Jordan Lee', LAST_MON + 'T13:00:00Z', null)], [])];
    r = await build(browser, baseUrl, 'safety_signoff', { start: LAST_MON, end: LAST_SUN });
    const longForm = fig(r.out && r.out.items[0], 'Form').value || '';
    ok('a long form title is shortened for the email\'s figures, and says so', longForm.length === 60 && longForm.endsWith('…'), longForm);
    SAFETY_DOCS = SAFETY_WEEKS.slice();

    console.log('\nEnd to end — runSchedule, to the mail service');
    // The database the runner reads, as three answers: the account it runs
    // as, that account's access, and the recipient group.
    const fakeSql = (strings) => {
      const q = strings.join('?');
      if (/FROM users u\s+JOIN companies c ON c\.code = u\.company_code\s+WHERE u\.id/.test(q) && /AS company_name/.test(q)) {
        return Promise.resolve([{ id: 7, username: 'robot-admin', company_code: 'FCT', company_name: 'Force Corp' }]);
      }
      if (/u\.division_roles/.test(q)) {
        return Promise.resolve([{ division_roles: ACCT.divisionRoles, divisions: null, role: 'admin', is_platform_admin: false,
          company_code: 'FCT', allowed_divisions: ['turf'] }]);
      }
      if (/FROM report_recipient_groups/.test(q)) {
        return Promise.resolve([{ id: 1, name: 'Turf PMs', emails: ['PM@example.com', 'super@example.com'] }]);
      }
      return Promise.reject(new Error('unexpected query: ' + q.slice(0, 80)));
    };
    const sched = {
      id: 99, company_code: 'FCT', report_type: 'turf_daily_pm', division: 'turf', project_id: '*', project_name: null,
      options: {}, frequency: 'weekdays', send_time: '06:30', timezone: 'America/New_York', group_ids: [1],
      subject: null, note: 'Numbers through yesterday.', attach_pdf: true, enabled: true,
      run_as_user_id: 7, run_as_username: 'robot-admin',
    };
    SENT.length = 0;
    writes.length = 0;
    let res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date() });
    ok('every In Progress job goes out as its own email', res.status === 'sent' && res.sent === 2 && SENT.length === 2,
      JSON.stringify(res));
    const first = SENT[0] || {};
    ok('…to the group, folded to lower case', JSON.stringify(first.to) === '["pm@example.com","super@example.com"]', JSON.stringify(first.to));
    ok('…with the button\'s subject', /^Daily PM Report — Turf Maple Ave/.test(first.subject || ''), first.subject);
    const pdf = (first.attachments || []).find(a => a.contentType === 'application/pdf');
    ok('…the report attached as a real PDF', pdf && Buffer.from(pdf.content, 'base64').subarray(0, 5).toString() === '%PDF-',
      JSON.stringify((first.attachments || []).map(a => a.filename)));
    ok('…and the note in the body', String(first.html || '').includes('Numbers through yesterday.'));
    ok('…and the result says so in words', res.message === 'Sent 2 reports to 2 recipients.', res.message);
    ok('…and nothing was written while building it', writes.length === 0, writes.join(', '));

    SENT.length = 0;
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'payroll_hours', division: 'payroll', project_id: null,
      options: { range: 'last_week' } }, { baseUrl, browser, now: new Date() });
    const ppdf = ((SENT[0] || {}).attachments || []).find(a => a.contentType === 'application/pdf');
    const pbuf = ppdf ? Buffer.from(ppdf.content, 'base64') : Buffer.alloc(0);
    ok('payroll end to end: the hours report goes out as a PDF',
      res.status === 'sent' && SENT.length === 1 && pbuf.subarray(0, 5).toString() === '%PDF-', JSON.stringify(res));
    ok('…landscape, the way the page prints it', /\/MediaBox\s*\[\s*0\s+0\s+792(\.\d+)?\s+612/.test(pbuf.toString('latin1')),
      (pbuf.toString('latin1').match(/\/MediaBox\s*\[[^\]]*\]/) || [])[0]);
    ok('…with the figures in the email body', /Total Paid/.test((SENT[0] || {}).html || ''));
    // For a person to look at: SHOT_DIR=/some/dir keeps the PDF that was sent.
    if (process.env.SHOT_DIR && pbuf.length) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'payroll-hours.pdf'), pbuf);
    SENT.length = 0;
    const safetySched = { ...sched, report_type: 'safety_signoff', division: 'safety', project_id: null, options: { period: 'prev_week' } };
    res = await runSchedule(fakeSql, safetySched, { baseUrl, browser, now: new Date() });
    const spdf = ((SENT[0] || {}).attachments || []).find(a => a.contentType === 'application/pdf');
    const sbuf = spdf ? Buffer.from(spdf.content, 'base64') : Buffer.alloc(0);
    ok('safety end to end: last week\'s sign-off sheet goes out as a PDF',
      res.status === 'sent' && SENT.length === 1 && sbuf.subarray(0, 5).toString() === '%PDF-'
        && /^Safety Sign-Off Report — Week of /.test(SENT[0].subject), JSON.stringify(res));
    ok('…portrait, the way the sheet prints', /\/MediaBox\s*\[\s*0\s+0\s+612(\.\d+)?\s+792/.test(sbuf.toString('latin1')),
      (sbuf.toString('latin1').match(/\/MediaBox\s*\[[^\]]*\]/) || [])[0]);
    ok('…with who has not signed in the email body', /Not Signed/.test((SENT[0] || {}).html || ''));
    if (process.env.SHOT_DIR && sbuf.length) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'safety-signoff.pdf'), sbuf);
    // Crew hold the division to sign; only a supervisor may read the report.
    const crewSql = (strings, ...vals) => /u\.division_roles/.test(strings.join('?'))
      ? Promise.resolve([{ division_roles: { safety: 'level1' }, divisions: null, role: 'user', is_platform_admin: false,
          company_code: 'FCT', allowed_divisions: [] }])
      : fakeSql(strings, ...vals);
    SENT.length = 0;
    res = await runSchedule(crewSql, safetySched, { baseUrl, browser, now: new Date() });
    ok('…and run as somebody since moved to crew, it fails saying so, and nothing goes',
      res.status === 'failed' && SENT.length === 0 && /no longer a Safety Center supervisor/.test(res.message), JSON.stringify(res));
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'trucking_labor_dispatch', division: 'trucking', project_id: null,
      options: { day: 'today' } }, { baseUrl, browser, now: new Date() });
    ok('a dispatch with nothing on the board is skipped, and nothing is sent',
      res.status === 'skipped' && SENT.length === 0 && /Nothing to send — Nothing scheduled/.test(res.message), JSON.stringify(res));
    console.log('\nWhat the review found');
    // The bypass secret goes to the app and nowhere else.
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'SECRET-BYPASS';
    const fixtureDef = { page: '__fixture/bypass.html', division: 'turf', label: 'Fixture' };
    let fx;
    try { fx = await buildInBrowser(browser, { baseUrl, def: fixtureDef, acct: ACCT, spec: { type: 'fixture', timezone: 'America/New_York' } }); }
    catch (err) { fx = { error: err.message }; }
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    ok('the deployment-protection bypass secret goes to the app\'s own requests…', !fx.error && fx.items.length === 1 && BYPASS_SEEN.app >= 2,
      fx.error || JSON.stringify(BYPASS_SEEN));
    ok('…and never to another origin, a CDN\'s included', BYPASS_SEEN.other === 0, JSON.stringify(BYPASS_SEEN));

    // One slow AI answer costs that job its AI block, not the run.
    AI_DELAY.p1 = 25000;
    const t0 = Date.now();
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: '*' });
    delete AI_DELAY.p1;
    ok('a Daily PM job whose AI read is slow still goes out, without the AI block, and the next job too',
      !r.error && r.out.items.length === 2 && !has(r.out.items[0], 'pacing ahead') && has(r.out.items[1], 'pacing ahead'),
      r.error || JSON.stringify({ n: r.out.items.length, errs: r.out.errors }));
    ok('…waiting about twenty seconds for it, not forever', Date.now() - t0 < 60000, `${Date.now() - t0}ms`);

    // A failed read is a failure, not "nothing to send".
    FAIL.add('fct_conschedule_p1');
    r = await build(browser, baseUrl, 'turf_construction_schedule', { projectId: 'p1' });
    FAIL.clear();
    ok('a construction schedule that could not be read fails, rather than "never built"',
      !r.error && r.out.items.length === 0 && r.out.skipped.length === 0 && /could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    FAIL.add('fct_scheduler_assignments');
    r = await build(browser, baseUrl, 'scheduler_dispatch', { day: YESTERDAY });
    FAIL.clear();
    ok('crew assignments that could not be read fail the dispatch, rather than "nothing scheduled"',
      !r.error && r.out.skipped.length === 0 && /crew assignments could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    FAIL.add('/api/dust-config');
    r = await build(browser, baseUrl, 'dust_tracking_summary', { start: daysAgo(7), end: YESTERDAY });
    FAIL.clear();
    ok('dust rates that could not be read fail the report, rather than price every gallon at $0',
      !r.error && r.out.items.length === 0 && /rates and customer list did not load/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    STORE.fct_quarry_sales = [{ id: 's1', date: YESTERDAY, location: 'Pit 2', product: '2A Modified', tons: 400, price: 14, total: 5600 }];
    FAIL.add('fct_quarry_monthly_fixed');
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    FAIL.clear();
    delete STORE.fct_quarry_sales;
    ok('quarry fixed costs that could not be read fail the break-even, rather than email it without them',
      !r.error && r.out.items.length === 0 && /did not load/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));

    // Switched off while it was being built: nothing more goes.
    SENT.length = 0;
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(),
      stillWanted: async () => 'It was switched off while it was being built, so nothing more was sent.' });
    ok('a schedule switched off mid-run sends nothing more, and says why',
      SENT.length === 0 && res.status === 'skipped' && /switched off/.test(res.message), JSON.stringify(res));

    // More addresses than one email carries go as several emails, not fewer people.
    const manySql = (strings, ...vals) => {
      const q = strings.join('?');
      if (/FROM report_recipient_groups/.test(q)) {
        return Promise.resolve([{ id: 1, name: 'Everyone', emails: Array.from({ length: 63 }, (_, i) => `crew${i}@example.com`) }]);
      }
      return fakeSql(strings, ...vals);
    };
    SENT.length = 0;
    res = await runSchedule(manySql, { ...sched, report_type: 'executive', division: 'executive', project_id: null },
      { baseUrl, browser, now: new Date() });
    ok('63 addresses: the report goes as two emails of 50 and 13, the PDF on both',
      res.status === 'sent' && SENT.length === 2 && SENT[0].to.length === 50 && SENT[1].to.length === 13
        && SENT.every(m => (m.attachments || []).some(a => a.contentType === 'application/pdf'))
        && res.message === 'Sent to 63 recipients.',
      JSON.stringify({ res, sizes: SENT.map(m => m.to.length) }));

    console.log('\nWhat production found');
    // An account from before daily rows had their own table: jobs with no rows
    // there, and the old all-projects record still carrying theirs. The page
    // moves those rows over at boot — a write, refused here — and the job
    // pages retry a failed save three times with backoff. Refused as a network
    // failure, that was seven seconds a job, and 90s ran out before the page
    // reached the report (Turf, Bid Line Items, first production run).
    const savedIndex = STORE.fct_projects_index;
    const legacy = [];
    STORE.fct_projects_index = savedIndex.concat(['L1', 'L2', 'L3', 'L4']);
    for (const id of ['L1', 'L2', 'L3', 'L4']) {
      STORE['fct_project_' + id] = { id, 'project-name': 'Old ' + id, 'job-number': '21' + id, status: 'Complete', bidItems: [] };
      legacy.push({ ...STORE['fct_project_' + id], dailyRows: [
        { id: id + '-r1', date: daysAgo(700), cost_code: '0100', sub_code: 'Excavation', quantity: 40, labor_hours: 8, employee: 'Sam' }] });
    }
    STORE.fct_projects = legacy;
    const t1 = Date.now();
    r = await build(browser, baseUrl, 'turf_bid_items', { projectId: '*' });
    const took = Date.now() - t1;
    STORE.fct_projects_index = savedIndex;
    delete STORE.fct_projects;
    for (const id of ['L1', 'L2', 'L3', 'L4']) delete STORE['fct_project_' + id];
    ok('a page that tries to move old rows at boot still opens in seconds, its saves refused at once',
      !r.error && r.out.items.length === 2 && took < 15000, r.error || `${took}ms, ${r.out.items.length} items`);
    ok('…and nothing written', r.writes.length === 0, JSON.stringify(r.writes));

    // A page stuck on a request says which one, in the schedule's row.
    HANG.add('/api/daily-rows');
    let stuck;
    try {
      // A deadline 63s out leaves plan() about 13s (each wait keeps 50s back
      // for sending), so this takes seconds rather than the full 90.
      await buildInBrowser(browser, { baseUrl, def: SCHEDULABLE.turf_bid_items, acct: ACCT,
        spec: { type: 'turf_bid_items', projectId: '*', options: {}, timezone: 'America/New_York', today: ymd(today) },
        deadline: Date.now() + 63_000 });
      stuck = 'built';
    } catch (err) { stuck = err.message; }
    HANG.clear();
    ok('a page that never finishes loading names the request it is waiting on',
      /^Opening the report took longer than \d+s\. Still waiting on GET \/api\/daily-rows\?/.test(stuck), stuck);

    console.log('\nWhat production found, the second time');
    // A rejected answer to a paused request (here: a header Chrome refuses)
    // used to go unhandled, which ends the function on Vercel — a bare 500.
    const rejections = [];
    const onRejection = e => rejections.push(String((e && e.message) || e));
    process.on('unhandledRejection', onRejection);
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bad\nsecret';
    SENT.length = 0;
    const steps = [];
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), progress: t => steps.push(t) });
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    await sleep(200);
    process.removeListener('unhandledRejection', onRejection);
    ok('a request Chrome will not take with the bypass header still goes, without it — no stray rejection, nothing hung',
      res.status === 'sent' && SENT.length === 2 && rejections.length === 0, JSON.stringify({ res, rejections }));
    ok('the run notes each step as it goes, with what has been sent and the memory in use',
      /^Opening the Turf Management page; 0 reports sent so far; \d+ MB in use$/.test(steps[0] || '')
        && steps.some(t => /^Building Turf Maple Ave \(1 of 2\); 0 reports sent so far/.test(t))
        && /^Making the PDF and sending Turf Oak St \(2 of 2\); 1 report sent so far; \d+ MB in use$/.test(steps[steps.length - 1] || ''),
      JSON.stringify(steps));

    // The robot's copy of a job page loads what reports are built from, and
    // not what a person's does besides: no CRM, no recovery passes (they write
    // the list back, and read the old blob and every row again).
    ASKED.length = 0;
    r = await build(browser, baseUrl, 'turf_bid_items', { projectId: '*' });
    const crm = ASKED.filter(a => /fct_crm_/.test(a));
    const recovery = ASKED.filter(a => /\/api\/data\/fct_projects($|\?)|_keys\?prefix=fct_project_/.test(a));
    ok('the robot\'s Turf page skips the CRM and the recovery passes, and still builds every job',
      !r.error && r.out.items.length === 2 && crm.length === 0 && recovery.length === 0,
      r.error || JSON.stringify({ crm, recovery, n: r.out.items.length }));
    ok('…but reads the whole daily-row history the reports are built from',
      ASKED.some(a => /^GET \/api\/daily-rows\?division=turf$/.test(a)) && ASKED.some(a => /^GET \/api\/daily-rows\?since=/.test(a)),
      JSON.stringify(ASKED.filter(a => /daily-rows/.test(a))));

    // A slow step leaves a note every five seconds: how long, what it waits on, the memory.
    AI_DELAY.p1 = 12000;
    const beats = [];
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, project_id: 'p1', project_name: 'Turf Maple Ave' },
      { baseUrl, browser, now: new Date(), progress: t => beats.push(t) });
    delete AI_DELAY.p1;
    ok('a slow step is noted every few seconds, with how long, what it is waiting on and the memory',
      res.status === 'sent' && beats.some(t => /^Building Turf Maple Ave, \d+s in, waiting on POST \/api\/ai\/schedule-analysis \(\d+s\); 0 reports sent so far; \d+ MB in use$/.test(t)),
      JSON.stringify(beats));

    // A preview behind Vercel's login: say so, not "net::ERR_FAILED".
    let away;
    try {
      await buildInBrowser(browser, { baseUrl, def: { page: '__fixture/protected.html', division: 'turf', label: 'Fixture' }, acct: ACCT,
        spec: { type: 'fixture', timezone: 'America/New_York' } });
      away = 'opened';
    } catch (err) { away = err.message; }
    ok('a deployment behind Vercel\'s login is named as that, with what to do — not net::ERR_FAILED',
      /behind Vercel's login \(Deployment Protection\)/.test(away) && /Protection Bypass for Automation/.test(away) && !/ERR_FAILED/.test(away), away);
    try {
      await buildInBrowser(browser, { baseUrl, def: { page: '__fixture/denied.html', division: 'turf', label: 'Fixture' }, acct: ACCT,
        spec: { type: 'fixture', timezone: 'America/New_York' } });
      away = 'opened';
    } catch (err) { away = err.message; }
    ok('…and one that answers 401 says the deployment refused the robot', /answered HTTP 401/.test(away) && /refused the report robot/.test(away), away);
    const openFixture = async page => {
      const t = Date.now();
      try {
        await buildInBrowser(browser, { baseUrl, def: { page, division: 'turf', label: 'Fixture' }, acct: ACCT,
          spec: { type: 'fixture', timezone: 'America/New_York' } });
        return { msg: 'opened', ms: Date.now() - t };
      } catch (err) { return { msg: err.message, ms: Date.now() - t }; }
    };
    let o = await openFixture('__fixture/script-login.html');
    ok('a login page that redirects in script is named too, at once rather than after the whole load wait',
      /behind Vercel's login/.test(o.msg) && o.ms < 10000, JSON.stringify(o));
    o = await openFixture('__fixture/other-sso.html');
    ok('another site\'s sign-in is not blamed on Vercel — it names where the robot was sent',
      !/Vercel/.test(o.msg) && o.msg.includes('sent the report robot to ' + OTHER_ORIGIN.replace('http://', '')), o.msg);
    o = await openFixture('__fixture/to-https.html');
    ok('an address given as http for an https site says so, not "X sent it to X"',
      /sent the report robot to https:\/\//.test(o.msg) && /APP_BASE_URL/.test(o.msg), o.msg);
    process.env.VERCEL_ENV = 'production';
    o = await openFixture('__fixture/protected.html');
    delete process.env.VERCEL_ENV;
    ok('turned away on production, it does not claim production is unprotected',
      /includes production/.test(o.msg) && !/Production domains are not behind it/.test(o.msg), o.msg);

    // The page's own sync timers: a person's page polls every minute; the
    // robot's must not, or a long run loads the CRM and redraws the home tab.
    const timersOf = async robot => {
      const pg = await browser.newPage();
      try {
        await pg.evaluateOnNewDocument((user) => {
          localStorage.setItem('fct_token', 'a.b.c');
          localStorage.setItem('fct_user', user);
          localStorage.setItem('fct_division', 'turf');
          window.__timers = [];
          const real = window.setInterval;
          window.setInterval = function (fn, ms) { window.__timers.push((fn && fn.name) || ''); return real.apply(this, arguments); };
        }, JSON.stringify({ username: 'robot-admin', companyCode: 'FCT', role: 'admin', divisionRoles: ACCT.divisionRoles, isPlatformAdmin: true }));
        await pg.goto(`${baseUrl}/tracker.html${robot ? '?autoreport=1' : ''}`, { waitUntil: 'domcontentloaded' });
        await sleep(1500);
        return await pg.evaluate(() => window.__timers.filter(Boolean));
      } finally { await pg.close(); }
    };
    const robotTimers = await timersOf(true), personTimers = await timersOf(false);
    const SYNC = ['_pollAll', '_pollHomeFeeds', 'pollLists'];
    ok('the robot\'s page starts none of the page\'s sync polls; a person\'s page still starts all of them',
      SYNC.every(n => !robotTimers.includes(n)) && SYNC.every(n => personTimers.includes(n)),
      JSON.stringify({ robotTimers, personTimers }));

    console.log('\nPicked jobs');
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'turf_bid_items',
      picked_jobs: [{ id: 'p2', name: 'Turf Oak St' }, { id: 'p3', name: 'Turf Done Job' }] }, { baseUrl, browser, now: new Date() });
    const subj = SENT.map(m => m.subject).sort();
    ok('a schedule for picked jobs sends those jobs, one email each — a Complete one included — and no others',
      res.status === 'sent' && SENT.length === 2 && /Done Job/.test(subj.join('|')) && /Oak St/.test(subj.join('|')) && !/Maple Ave/.test(subj.join('|')),
      JSON.stringify({ res, subj }));
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'turf_bid_items',
      picked_jobs: [{ id: 'p1', name: 'Turf Maple Ave' }, { id: 'gone1', name: 'Old Pier' }] }, { baseUrl, browser, now: new Date() });
    ok('a picked job deleted since fails on its own, by name, and the rest still go',
      res.status === 'partial' && SENT.length === 1 && /Maple Ave/.test(SENT[0].subject || '') && /Old Pier is no longer in Turf/.test(res.message),
      JSON.stringify(res));

    console.log('\nWhat the second review found');
    // Stopped partway — here, saved over mid-send — the rest is handed back,
    // and the next pass sends only what is left.
    let handed = null;
    let stillAsks = 0;
    const occ = new Date(Date.now() - 60000);
    SENT.length = 0;
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), occurrence: occ,
      stillWanted: async () => (++stillAsks > 1 ? 'It was changed while it was being built, so nothing more was sent; the next run uses the new settings.' : null),
      handBack: async h => { handed = h; return true; } });
    ok('saved over after its first email: the rest is handed to the next pass, not dropped',
      res.status === 'continuing' && SENT.length === 1 && handed && JSON.stringify(handed.state.done) === '["p1"]'
        && handed.state.idle === 0 && /goes out at the next pass, with the new settings/.test(res.message),
      JSON.stringify({ res, handed }));
    SENT.length = 0;
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), occurrence: occ, resume: handed && handed.state,
      handBack: async () => { throw new Error('should not be asked'); } });
    ok('…and the next pass sends only the job that had not gone, and reports on the whole',
      res.status === 'sent' && SENT.length === 1 && /Oak St/.test(SENT[0].subject || '')
        && res.message === 'Sent 2 reports to 2 recipients (over 2 runs).', JSON.stringify({ res, subjects: SENT.map(m => m.subject) }));
    SENT.length = 0;
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), occurrence: new Date(occ.getTime() + 864e5),
      resume: handed && handed.state });
    ok('what one occurrence sent is not skipped by the next (a pass killed before it could write itself down)',
      res.status === 'sent' && SENT.length === 2 && res.message === 'Sent 2 reports to 2 recipients.', JSON.stringify(res));

    // A job cut short by the run's time, not slow in itself, goes back whole.
    HANG.add('/api/data/fct_conschedule_p1');
    handed = null;
    SENT.length = 0;
    res = await runSchedule(fakeSql, { ...sched, report_type: 'turf_job_summary' }, { baseUrl, browser, now: new Date(), occurrence: occ,
      deadline: Date.now() + 75_000, handBack: async h => { handed = h; return true; } });
    HANG.clear();
    ok('a job whose build the run\'s own deadline cut short is handed back with the rest, not written off',
      res.status === 'continuing' && SENT.length === 0 && handed && handed.state.done.length === 0 && handed.state.attempted === 0
        && /2 more jobs go out at the next pass/.test(res.message), JSON.stringify({ res, handed }));

    // One report, timed out, then sent at the next pass: it reads as sent.
    HANG.add('/api/data/fct_conschedule_p1');
    handed = null;
    const one = { ...sched, report_type: 'turf_job_summary', project_id: 'p1', project_name: 'Turf Maple Ave' };
    res = await runSchedule(fakeSql, one, { baseUrl, browser, now: new Date(), occurrence: occ,
      deadline: Date.now() + 75_000, handBack: async h => { handed = h; return true; } });
    HANG.clear();
    ok('a single report that timed out is tried again, counted as a pass that got nothing done',
      res.status === 'continuing' && handed && handed.state.idle === 1 && handed.state.attempted === 0 && handed.state.problems.length === 0,
      JSON.stringify({ res, handed }));
    SENT.length = 0;
    res = await runSchedule(fakeSql, one, { baseUrl, browser, now: new Date(), occurrence: occ, resume: handed && handed.state });
    ok('…and when it goes out at the next pass, it reads as sent — not partly, over the first try',
      res.status === 'sent' && SENT.length === 1 && !/took longer/.test(res.message), JSON.stringify(res));

    // Out of time before anything went: tried again at the next pass.
    HANG.add('/api/daily-rows');
    handed = null;
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), deadline: Date.now() + 63_000,
      handBack: async h => { handed = h; return true; } });
    ok('a run whose page ran out of time before sending anything is tried again at the next pass',
      res.status === 'continuing' && handed && handed.state.idle === 1 && /tried again at the next pass/.test(res.message),
      JSON.stringify({ res, handed }));
    res = await runSchedule(fakeSql, sched, { baseUrl, browser, now: new Date(), deadline: Date.now() + 63_000 });
    HANG.clear();
    ok('…and without a next pass to give it to (Send now), it fails, saying why', res.status === 'failed' && /took longer than/.test(res.message),
      res.message);

    // A job whose build times out is still running in its page; the next job
    // gets a fresh page, and its own report.
    HANG.add('/api/data/fct_conschedule_p1');
    SENT.length = 0;
    const t2 = Date.now();
    res = await runSchedule(fakeSql, { ...sched, report_type: 'turf_job_summary' }, { baseUrl, browser, now: new Date() });
    HANG.clear();
    ok('after one job\'s report times out, the next job still goes out — its own report, not the stuck one\'s',
      res.status === 'partial' && SENT.length === 1 && /Oak St/.test(SENT[0].subject || '') && !/Maple Ave/.test(SENT[0].subject || '')
        && /Maple Ave: Building the report took longer than/.test(res.message),
      JSON.stringify({ res, subjects: SENT.map(m => m.subject), took: Date.now() - t2 }));

    // Reads that still answered a failure with defaults.
    FAIL.add('fct_conschedule_p1');
    r = await build(browser, baseUrl, 'turf_job_summary', { projectId: 'p1' });
    FAIL.clear();
    ok('a Job Summary whose construction schedule could not be read fails, rather than say none was built',
      !r.error && r.out.items.length === 0 && /construction schedule could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    FAIL.add('fct_kiewit_conschedule_p1');
    r = await build(browser, baseUrl, 'kiewit_job_summary', { projectId: 'p1' });
    FAIL.clear();
    ok('…Kiewit\'s too', !r.error && r.out.items.length === 0 && /construction schedule could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));

    const p1 = STORE.fct_project_p1;
    STORE.fct_project_p1 = { ...p1 };
    delete STORE.fct_project_p1['end-date'];
    FAIL.add('/api/deadlines');
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: 'p1' });
    ok('a Daily PM for a job whose deadline lives in the deadlines list fails when that list cannot be read',
      !r.error && r.out.items.length === 0 && /project deadlines could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    r = await build(browser, baseUrl, 'turf_job_summary', { projectId: 'p1' });
    ok('…so does a Job Summary, whose schedule page draws the same deadline',
      !r.error && r.out.items.length === 0 && /project deadlines could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    const pv1 = STORE.fct_paving_project_p1;
    STORE.fct_paving_project_p1 = { ...pv1 };
    delete STORE.fct_paving_project_p1['end-date'];
    r = await build(browser, baseUrl, 'paving_job_summary', { projectId: 'p1' });
    STORE.fct_paving_project_p1 = pv1;
    ok('…Paving\'s too', !r.error && r.out.items.length === 0 && /project deadlines could not be read/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));
    STORE.fct_project_p1 = p1;
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: 'p1' });
    ok('…and one with its own end date still goes', !r.error && r.out.items.length === 1, r.error || JSON.stringify(r.out));
    // Every job, the list down: the AI is asked only about the job that knows its deadline.
    const p2 = STORE.fct_project_p2;
    STORE.fct_project_p2 = { ...p2 };
    delete STORE.fct_project_p2['end-date'];
    AI_SEEN.pids.length = 0;
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: '*' });
    STORE.fct_project_p2 = p2;
    FAIL.clear();
    ok('an every-job Daily PM with the deadlines list down asks the AI only about jobs whose deadline it knows',
      !r.error && r.out.items.length === 1 && /project deadlines could not be read/.test((r.out.errors[0] || {}).error)
        && AI_SEEN.pids.includes('p1') && !AI_SEEN.pids.includes('p2'),
      r.error || JSON.stringify({ pids: AI_SEEN.pids, errs: r.out.errors, n: r.out.items.length }));

    STORE.fct_quarry_sales = [{ id: 's1', date: YESTERDAY, location: 'Pit 2', product: '2A Modified', tons: 400, price: 14, total: 5600 }];
    FAIL.add('fct_quarry_benchmarks');
    r = await build(browser, baseUrl, 'quarry_breakeven', { year: String(today.getFullYear()) });
    FAIL.clear();
    delete STORE.fct_quarry_sales;
    ok('a break-even whose benchmarks could not be read fails, rather than show the stock ranges as the company\'s',
      !r.error && r.out.items.length === 0 && /benchmarks did not load/.test((r.out.errors[0] || {}).error),
      r.error || JSON.stringify(r.out));

    // A Daily PM for every job asks the AI about all of them at once.
    AI_DELAY.p1 = 3000; AI_DELAY.p2 = 3000;
    AI_SEEN.max = 0;
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: '*' });
    delete AI_DELAY.p1; delete AI_DELAY.p2;
    ok('a Daily PM for every job reads the AI for its jobs together, not one after another',
      !r.error && r.out.items.length === 2 && AI_SEEN.max >= 2 && r.out.items.every(it => has(it, 'pacing ahead')),
      r.error || JSON.stringify({ max: AI_SEEN.max, n: r.out.items.length }));
    AI_SEEN.max = 0;
    r = await build(browser, baseUrl, 'turf_daily_pm', { projectId: 'p1' });
    ok('…and a one-job Daily PM asks about that job only', !r.error && r.out.items.length === 1 && AI_SEEN.max === 1,
      r.error || JSON.stringify({ max: AI_SEEN.max }));

    // Payroll's ranges count from the day the report was due.
    r = await build(browser, baseUrl, 'payroll_hours', { options: { range: 'current_week' }, today: LAST_SUN });
    const wantSpan = (() => {
      const a = new Date(LAST_MON + 'T00:00:00'), b = new Date(LAST_SUN + 'T00:00:00');
      const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (a.getFullYear() !== b.getFullYear()) return `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
      if (a.getMonth() === b.getMonth()) return `${md(a)}–${b.getDate()}, ${b.getFullYear()}`;
      return `${md(a)} – ${md(b)}, ${b.getFullYear()}`;
    })();
    ok('a payroll report due Sunday night and run after midnight covers the week it was due in',
      !r.error && r.out.items.length === 1 && (r.out.items[0].subject || '').endsWith(wantSpan),
      r.error || (r.out.items[0] || {}).subject + ' vs ' + wantSpan + ' ' + JSON.stringify(r.out.skipped));
  } finally {
    await browser.close();
    server.close();
    other.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
