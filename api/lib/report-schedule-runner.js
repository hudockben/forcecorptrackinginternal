'use strict';

// Run one scheduled report: build it the way its Email button does, and send
// it to the schedule's recipient groups.
//
// "The way its Email button does" is literal. The reports are built in the
// division pages, from the data those pages load, by functions that are
// thousands of lines of page code apiece. Rebuilding them here would give
// every report two copies that drift apart within a release, and the first a
// PM would hear of it is a number in the 6:30 email that does not match the
// screen. So the runner opens the page in headless Chrome, signed in as the
// admin who scheduled it, waits for the page's data, and calls the page's own
// builder through window.dwAutoReport (auto-report.js). Then it sends what
// came back through the same delivery path the button uses.
//
// The robot only reads. Every write the page attempts while it is open —
// presence heartbeats, the dust page's unload flush, a cleanup pass on boot —
// is refused at the network layer. A page left open by a person can save; a
// page opened by a timer to read a report must never be the thing that
// overwrote a foreman's afternoon of entries.
//
// Access is checked at every send, against the account as it is now: a
// division taken away from the admin who scheduled a report stops that report
// rather than leaving a timetable as a way around Manage Users.

const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { currentAccess } = require('./auth');
const { MAX_HTML_BYTES, isValidEmail, normalizeAttachments } = require('./email');
const { launchBrowser } = require('./pdf');
const { deliverReport } = require('./report-delivery');
const { SCHEDULABLE, DIVISIONS, PAY_RANGES, mayUseDivision } = require('./report-catalog');
const T = require('./report-schedule-time');

// Time limits. The function running all this is killed at 300s (vercel.json),
// so every wait is the smaller of its own limit and what is left before the
// run's deadline, keeping back enough to send what has been built.
const PAGE_LOAD_MS  = 45_000;   // the page, and its data, before it offers the report
const BUILD_MS      = 90_000;   // one report — one job's, for an every-job schedule
const SEND_NEEDS_MS = 50_000;   // a PDF render (up to 45s) and the mail service
// Resend allows a couple of requests a second; an "every In Progress job"
// schedule sends one email per job, back to back.
const SEND_GAP_MS   = 600;
// A job-by-job schedule over a company's whole active list could run past the
// function's time limit. This many is well inside it, and a company with more
// active jobs than this should be splitting the schedule up anyway.
const MAX_ITEMS     = 40;

// A claim older than this belongs to a run that died, and is free to take.
const STALE_CLAIM    = '15 minutes';
const STALE_CLAIM_MS = 15 * 60 * 1000;

// The POSTs that are questions rather than writes. The Daily PM report's AI
// read of a job goes out as a POST; it saves nothing but its own once-a-day
// answer cache, and without it the scheduled copy would be missing the block
// the button's copy has.
const READ_ONLY_POSTS = new Set(['/api/ai/schedule-analysis']);
const READ_ONLY_BODY  = JSON.stringify({ error: 'Scheduled report runs are read-only.' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function divisionName(key) {
  const d = DIVISIONS.find(x => x.key === key);
  return d ? d.name : key;
}

/** How long a step may take: its own limit, or what the deadline leaves after `reserve`. */
function budget(deadline, max, reserve = 0) {
  if (!deadline) return max;
  return Math.min(max, deadline - Date.now() - reserve);
}

/**
 * The page's origin, for the headless browser to open.
 *
 * Never taken from the request when the deployment knows its own address.
 * The robot carries a live session for the schedule's owner into whatever
 * origin it opens, so a Host header an admin could shape would let them
 * point it at a page of their own and walk off with another admin's token.
 * APP_BASE_URL wins when set; then the platform's own address — production's
 * domain in production, the deployment's URL on a preview, so a preview's
 * "Send now" builds with that preview's pages. Only with neither (a laptop
 * running the dev server) does the request's host stand in.
 */
function appBaseUrl(req) {
  const explicit = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const platform = process.env.VERCEL_ENV === 'production'
    ? (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)
    : process.env.VERCEL_URL;
  if (platform) return `https://${String(platform).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const h = req && req.headers ? req.headers.host : '';
  if (h) {
    const host = String(h).split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return `${local ? 'http' : 'https'}://${host}`;
  }
  return '';
}

/** The account a schedule runs as, with its access as of now — or null. */
async function loadRunAs(sql, sched) {
  const rows = await sql`
    SELECT u.id, u.username, u.company_code, c.name AS company_name
      FROM users u
      JOIN companies c ON c.code = u.company_code
     WHERE u.id = ${sched.run_as_user_id}
     LIMIT 1`;
  const row = rows && rows[0];
  if (!row) return null;
  if (String(row.company_code).toUpperCase() !== String(sched.company_code).toUpperCase()) return null;
  const access = await currentAccess(sql, { userId: row.id, companyCode: row.company_code });
  if (!access) return null;
  return {
    userId:      row.id,
    username:    row.username,
    companyCode: String(row.company_code).toUpperCase(),
    companyName: row.company_name || row.company_code,
    ...access,
  };
}

/**
 * Every address on the schedule's groups, de-duplicated, in the order the
 * groups were picked, plus how many groups have gone. Not capped: past the
 * fifty one email can carry, deliverReport sends it as several.
 */
async function recipientsFor(sql, companyCode, groupIds) {
  const ids = (Array.isArray(groupIds) ? groupIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { emails: [], groups: [], missing: 0 };
  const rows = (await sql`
    SELECT id, name, emails FROM report_recipient_groups
     WHERE company_code = ${companyCode} AND id = ANY(${ids})`)
    .sort((a, b) => ids.indexOf(Number(a.id)) - ids.indexOf(Number(b.id)));
  const seen = new Set();
  const emails = [];
  for (const g of rows) {
    for (const raw of (Array.isArray(g.emails) ? g.emails : [])) {
      const e = String(raw || '').trim().toLowerCase();
      if (!e || seen.has(e) || !isValidEmail(e)) continue;
      seen.add(e);
      emails.push(e);
    }
  }
  return { emails, groups: rows.map(g => g.name), missing: ids.length - rows.length };
}

/**
 * What the page is asked to build: the report, the job (or every In Progress
 * job), and the dates the schedule's period means in its zone.
 *
 * `at` is the occurrence being sent, not the moment the run got to it. A 6:30
 * report the server reaches at 6:34 is the 6:30 one; a Sunday 11:55 PM report
 * reached at 12:00 AM is still Sunday's, and a "previous day" built off the
 * clock instead would quietly cover the wrong day.
 */
function specFor(sched, def, at) {
  const now = at instanceof Date ? at : new Date(at);
  const tz   = T.isValidTimeZone(sched.timezone) ? sched.timezone : T.DEFAULT_TZ;
  const opts = sched.options && typeof sched.options === 'object' ? sched.options : {};
  const spec = {
    type:        sched.report_type,
    projectId:   sched.project_id || null,
    projectName: sched.project_name || null,
    options:     opts,
    timezone:    tz,
    today:       T.localDate(now, tz),
  };
  if (def.scope === 'job' && !spec.projectId) spec.projectId = '*';
  if (def.period) {
    const period = Object.prototype.hasOwnProperty.call(T.PERIODS, opts.period) ? opts.period : def.period;
    const r = T.periodRange(period, now, tz);
    spec.start = r.start;
    spec.end = r.end;
  }
  if (def.day) {
    const which = ['today', 'tomorrow', 'next_workday'].includes(opts.day) ? opts.day : def.day;
    spec.day = which === 'today' ? spec.today
      : which === 'tomorrow' ? T.localDate(now, tz, 1)
      : nextWorkday(now, tz);
  }
  if (def.payRange) {
    // A name, not dates: the payroll page knows its own weeks and cycles.
    spec.options = { ...opts, range: Object.prototype.hasOwnProperty.call(PAY_RANGES, opts.range) ? opts.range : def.payRange };
  }
  if (def.year) {
    spec.year = opts.year === 'all' ? 'all' : spec.today.slice(0, 4);
  }
  return spec;
}

function nextWorkday(now, tz) {
  for (let i = 1; i <= 7; i++) {
    const d = T.localDate(now, tz, i);
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd >= 1 && wd <= 5) return d;
  }
  return T.localDate(now, tz, 1);
}

/** A thirty-minute session for the robot — the account's own, as login.js signs it. */
function robotToken(acct) {
  return jwt.sign({
    userId:           acct.userId,
    username:         acct.username,
    companyCode:      acct.companyCode,
    companyName:      acct.companyName,
    role:             acct.role,
    divisionRoles:    acct.divisionRoles,
    allowedDivisions: acct.allowedDivisions,
    isPlatformAdmin:  acct.isPlatformAdmin,
  }, process.env.JWT_SECRET, { expiresIn: '30m' });
}

// `why`, if given, is asked at the moment of the timeout for what the page was
// doing then — so the schedule's row says what it was stuck on, not just that
// it was slow.
function withTimeout(promise, ms, what, why) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(async () => {
        let detail = '';
        try { detail = why ? await why() : ''; } catch { /* the bare message, then */ }
        rej(new Error(`${what} took longer than ${Math.round(ms / 1000)}s${detail ? '. ' + detail : ''}`));
      }, ms);
    }),
  ]);
}

/**
 * Open `def.page` as `acct`, ready to be asked for reports.
 *
 *   const session = await openReportPage(browser, { baseUrl, def, acct, spec, deadline });
 *   await session.plan(spec)         → { jobs: null } | { jobs: [{ id, name }] }
 *   await session.build(spec)        → { items, skipped, errors }
 *   await session.close()
 *
 * One page in the browser's default context. Not a fresh context per run,
 * which is the obvious way to keep one account's session from the next:
 * serverless Chrome runs single-process, and opening a second context there
 * kills the browser outright ("Target closed"). So the app origin's storage is
 * wiped instead — on open, for anything a crashed run left, and on close, so
 * the next schedule (another account, perhaps another company) opens on
 * nothing but what it is given.
 *
 * Throws, in words, when the page will not open or will not offer the report.
 */
async function openReportPage(browser, { baseUrl, def, acct, spec, deadline }) {
  if (!baseUrl) throw new Error('The server does not know its own address (set APP_BASE_URL).');
  const origin = new URL(baseUrl).origin;
  const stats = { blockedWrites: 0, pageErrors: [] };
  // For the message when the page is too slow: the app's requests still
  // open, and the last few things the page warned about.
  const inflight = new Map();
  const warnings = [];
  const page = await browser.newPage();
  let cdp = null;
  const wipe = async () => {
    try {
      if (!cdp) cdp = await page.createCDPSession();
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    } catch { /* best effort: the page may already be gone */ }
  };
  const close = async () => {
    // Off the app first, so nothing on it writes to storage after the wipe.
    try { await page.goto('about:blank', { timeout: 10_000 }); } catch { /* close regardless */ }
    await wipe();
    try { await page.close(); } catch { /* already gone */ }
  };

  try {
    await wipe();
    await page.setViewport({ width: 1440, height: 900 });
    // The page's "today" is the office's today: a report the schedule sends
    // at 9 PM Eastern must not be built for tomorrow because the server's
    // clock is already past midnight UTC.
    try { await page.emulateTimezone(spec.timezone); } catch { /* keep the server's */ }

    // Deployment Protection's bypass secret, for a preview that has it on —
    // added here, to the app's own requests only. Set on the page instead, it
    // rides along on every request the page makes, the CDN's included, and
    // that secret opens every protected deployment of the project.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
    await page.setRequestInterception(true);
    page.on('request', req => {
      try {
        const url = req.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return req.continue();
        let u;
        try { u = new URL(url); } catch { return req.abort(); }
        if (/^\/_vercel\/(insights|speed-insights)\//.test(u.pathname)) return req.abort();
        const method = req.method();
        const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
        if (u.origin === origin) {
          if (read || READ_ONLY_POSTS.has(u.pathname)) {
            if (u.pathname.startsWith('/api/')) inflight.set(req, Date.now());
            return bypass
              ? req.continue({ headers: { ...req.headers(), 'x-vercel-protection-bypass': bypass } })
              : req.continue();
          }
          // Refused the way a server refuses, not dropped the way a network
          // drops: the pages retry a failed connection with backoff (the job
          // pages give a refused bulk save 1 + 2 + 4 seconds), and a page that
          // does that once per job at boot never gets as far as the report.
          stats.blockedWrites++;
          return req.respond({ status: 403, contentType: 'application/json', body: READ_ONLY_BODY });
        }
        // The pages pull a few libraries and fonts from CDNs. Reads only, and
        // only the kinds of thing a page renders with.
        if (read && ['script', 'stylesheet', 'font', 'image'].includes(req.resourceType())) return req.continue();
        return req.abort();
      } catch { /* already handled */ }
    });
    page.on('requestfinished', req => inflight.delete(req));
    page.on('requestfailed', req => inflight.delete(req));
    // An alert() would hang the page forever with nobody to click OK.
    page.on('dialog', d => { d.dismiss().catch(() => {}); });
    page.on('pageerror', err => { if (stats.pageErrors.length < 5) stats.pageErrors.push(String(err && err.message || err)); });
    page.on('console', msg => {
      try {
        if (msg.type() !== 'warn' && msg.type() !== 'warning' && msg.type() !== 'error') return;
        const text = String(msg.text() || '');
        if (!text || /^Failed to load resource/.test(text)) return;   // the CDNs' noise, not the page's
        warnings.push(text.slice(0, 160));
        if (warnings.length > 3) warnings.shift();
      } catch { /* a message is never worth failing over */ }
    });

    const user = {
      username:         acct.username,
      companyCode:      acct.companyCode,
      companyName:      acct.companyName,
      role:             acct.role,
      divisionRoles:    acct.divisionRoles,
      allowedDivisions: acct.allowedDivisions,
      isPlatformAdmin:  acct.isPlatformAdmin,
    };
    await page.evaluateOnNewDocument((appOrigin, ls, readOnlyPosts, refusal) => {
      // The session goes to the app's own origin and nowhere else — not to
      // a page the app redirects to, not to a frame from somewhere else.
      if (location.origin !== appOrigin) return;
      try { for (const k of Object.keys(ls)) localStorage.setItem(k, ls[k]); } catch (_) { /* opaque origin */ }

      // The second lock on the door. Request interception refuses writes while
      // the page is open, but a page that flushes on its way out — the dust
      // page PUTs every row on pagehide, with keepalive so the request outlives
      // the page — hands that request to the browser after interception has
      // let go of it. So writes are also refused here, before they exist.
      const READS = ['GET', 'HEAD', 'OPTIONS'];
      const allowed = url => {
        try {
          const u = new URL(url, location.href);
          return u.origin !== location.origin || readOnlyPosts.includes(u.pathname);
        } catch (_) { return false; }
      };
      // Answered with a 403, as the server answers a write it will not take —
      // not a rejected fetch, which the pages read as a dropped connection
      // and retry with backoff.
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (!READS.includes(method) && !allowed(url)) {
          window.__dwRefusedWrites = (window.__dwRefusedWrites || 0) + 1;
          return Promise.resolve(new Response(refusal, { status: 403, headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch.apply(this, arguments);
      };
      if (navigator.sendBeacon) navigator.sendBeacon = () => false;
      const xhrOpen = XMLHttpRequest.prototype.open;
      const xhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__dwWrite = !READS.includes(String(method || 'GET').toUpperCase()) && !allowed(url);
        return xhrOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this.__dwWrite) throw new TypeError('Scheduled report runs are read-only.');
        return xhrSend.apply(this, arguments);
      };
    }, origin, {
      fct_token:        robotToken(acct),
      fct_user:         JSON.stringify(user),
      fct_division:     def.division,
      fct_company_code: acct.companyCode,
    }, [...READ_ONLY_POSTS], READ_ONLY_BODY);

    const loadMs = () => budget(deadline, PAGE_LOAD_MS, SEND_NEEDS_MS);
    if (loadMs() < 5_000) throw new Error('The run ran out of time before the page could be opened.');
    page.setDefaultTimeout(loadMs());
    await page.goto(`${baseUrl}/${def.page}?autoreport=1`, { waitUntil: 'domcontentloaded', timeout: loadMs() });

    try {
      await page.waitForFunction(
        t => window.dwAutoReport && window.dwAutoReport.has(t),
        { timeout: Math.max(1_000, loadMs()), polling: 250 }, spec.type);
    } catch {
      const where = (() => { try { return new URL(page.url()).pathname; } catch { return ''; } })();
      if (!where.endsWith('/' + def.page)) {
        throw new Error(`The ${divisionName(def.division)} page sent ${acct.username} away (to ${where || 'another page'}) instead of opening.`);
      }
      throw new Error(`The ${divisionName(def.division)} page did not offer this report`
        + (stats.pageErrors.length ? ` — it hit an error: ${stats.pageErrors[0]}` : '.'));
    }
  } catch (err) {
    await close();
    throw err;
  }

  // What the page was doing when it ran out of time, in a sentence or two.
  const stuckOn = async () => {
    const parts = [];
    const now = Date.now();
    const open = [...inflight].map(([req, at]) => {
      let where = req.url();
      try { const u = new URL(where); where = u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search); } catch { /* as is */ }
      return { where: `${req.method()} ${where}`, secs: Math.round((now - at) / 1000) };
    }).sort((a, b) => b.secs - a.secs);
    if (open.length) {
      parts.push('Still waiting on ' + open.slice(0, 3).map(o => `${o.where} (${o.secs}s)`).join(', ')
        + (open.length > 3 ? ` and ${open.length - 3} more` : '') + '.');
    }
    let refused = stats.blockedWrites;
    try { refused += await withTimeout(page.evaluate(() => window.__dwRefusedWrites || 0), 2_000, 'Reading the page'); } catch { /* the network count, then */ }
    if (refused) parts.push(`The page tried to save ${refused} time${refused === 1 ? '' : 's'} (refused: scheduled runs are read-only).`);
    if (!open.length && warnings.length) parts.push('Its last warning: ' + warnings[warnings.length - 1]);
    return parts.join(' ');
  };
  const ask = async (fn, s, what) => {
    const ms = budget(deadline, BUILD_MS, SEND_NEEDS_MS);
    if (ms < 10_000) throw new Error('The run ran out of time.');
    return withTimeout(page.evaluate(fn, s), ms, what, stuckOn);
  };
  return {
    stats,
    plan:  s => ask(x => window.dwAutoReport.plan(x), s, 'Opening the report'),
    build: s => ask(x => window.dwAutoReport.build(x), s, 'Building the report'),
    close,
  };
}

/**
 * Open the page and build everything the spec asks for, one report at a time,
 * without sending any of it. What the suite drives; runSchedule interleaves
 * the same steps with the sends.
 * Resolves to { items, skipped, errors, blockedWrites, pageErrors } or throws.
 */
async function buildInBrowser(browser, { baseUrl, def, acct, spec, deadline }) {
  const session = await openReportPage(browser, { baseUrl, def, acct, spec, deadline });
  const out = { items: [], skipped: [], errors: [] };
  try {
    for (const one of await specsToBuild(session, spec, out)) {
      try {
        const r = await session.build(one);
        out.items.push(...r.items); out.skipped.push(...r.skipped); out.errors.push(...r.errors);
      } catch (err) {
        out.errors.push({ projectId: one.projectId, projectName: one.projectName, error: err.message });
      }
    }
  } finally {
    await session.close();
  }
  return { ...out, ...session.stats };
}

/**
 * The builds a spec takes: itself, or — for "every In Progress job" — one per
 * job, each with its own time limit, so a slow job costs that job and not the
 * whole run's worth already built.
 */
async function specsToBuild(session, spec, out) {
  const plan = await session.plan(spec);
  if (!plan || !Array.isArray(plan.jobs)) return [spec];
  if (!plan.jobs.length) out.skipped.push({ why: 'No jobs are marked In Progress.' });
  return plan.jobs.map(j => ({ ...spec, projectId: j.id, projectName: j.name || null }));
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/**
 * Run one schedule now.
 *
 *   runSchedule(sql, sched, {
 *     now, baseUrl,
 *     occurrence?,   // the time it was due — what its dates are worked from
 *     browser?,      // a running Chrome to share; otherwise one is launched
 *     deadline?,     // epoch ms: start nothing that cannot finish before it
 *     stillWanted?,  // async () => reason | null — asked before each send
 *   })
 *
 * Builds and sends one report at a time, so whatever is sent before a timeout
 * or a failure stays sent and is counted.
 *
 * Resolves to { status, sent, total, recipientCount, message } — status one of
 * sent | partial | skipped | failed. Never throws.
 */
async function runSchedule(sql, sched, ctx = {}) {
  const now = ctx.now || new Date();
  const result = { status: 'failed', sent: 0, total: 0, recipientCount: 0, message: '' };
  const fail = msg => Object.assign(result, { status: 'failed', message: msg });

  const def = SCHEDULABLE[sched.report_type];
  if (!def) return fail('This report can no longer be scheduled.');

  let acct;
  try { acct = await loadRunAs(sql, sched); }
  catch (err) { return fail(`Could not read the account it runs as: ${err.message}`); }
  if (!acct) {
    return fail(`It runs as ${sched.run_as_username || 'a deleted account'}, which no longer exists. Open it and save it to run it as you.`);
  }
  if (!mayUseDivision(acct, def.division)) {
    return fail(def.division === 'payroll'
      ? `${acct.username} is no longer a payroll approver. Open it and save it as someone who is.`
      : `${acct.username} no longer has access to ${divisionName(def.division)}. Open it and save it as someone who does.`);
  }

  let recips;
  try { recips = await recipientsFor(sql, sched.company_code, sched.group_ids); }
  catch (err) { return fail(`Could not read its recipient groups: ${err.message}`); }
  if (!recips.emails.length) {
    return fail(recips.missing
      ? 'Its recipient group was deleted. Pick another group.'
      : 'Its recipient groups have no addresses on them.');
  }
  result.recipientCount = recips.emails.length;

  const spec = specFor(sched, def, ctx.occurrence || now);
  const tz = spec.timezone;
  const generatedAt = now.toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const problems = [];   // what kept something from going out
  const notes    = [];   // what went out, but not quite as asked
  const skipped  = [];
  let stopped    = null; // the schedule was switched off or changed mid-run
  let halted     = false; // the run stopped early, for whatever reason
  let attempted  = 0;

  let browser = ctx.browser || null;
  const ownBrowser = !browser;
  let session = null;
  try {
    if (!browser) {
      try { browser = await launchBrowser(); }
      catch (err) { return fail(`Could not start the report browser: ${err.message}`); }
    }
    try {
      session = await openReportPage(browser, { baseUrl: ctx.baseUrl, def, acct, spec, deadline: ctx.deadline });
    } catch (err) {
      return fail(err.message || 'The report page would not open.');
    }

    const holder = { items: [], skipped: [], errors: [] };
    let specs;
    try { specs = await specsToBuild(session, spec, holder); }
    catch (err) { return fail(err.message || 'The report could not be built.'); }
    skipped.push(...holder.skipped.map(s => s.why));
    if (specs.length > MAX_ITEMS) {
      notes.push(`${specs.length - MAX_ITEMS} more job${specs.length - MAX_ITEMS === 1 ? '' : 's'} not sent — a schedule sends at most ${MAX_ITEMS} at once. Split it up.`);
      specs = specs.slice(0, MAX_ITEMS);
    }

    let firstSend = true;
    for (let s = 0; s < specs.length && !halted; s++) {
      const one = specs[s];
      if (ctx.deadline && budget(ctx.deadline, Infinity, SEND_NEEDS_MS) < 10_000) {
        problems.push(`${specs.length - s} more not sent — the run ran out of time. Split this schedule up so each run is smaller.`);
        halted = true;
        break;
      }
      let built;
      try { built = await session.build(one); }
      catch (err) {
        attempted++;
        problems.push(`${one.projectName || def.label}: ${err.message}`);
        continue;
      }
      built.skipped.forEach(k => skipped.push(k.projectName ? `${k.projectName}: ${k.why}` : k.why));
      built.errors.forEach(e => { attempted++; problems.push(`${e.projectName || 'Report'}: ${e.error}`); });

      for (const it of built.items) {
        attempted++;
        const name = it.projectName || def.label;
        if (ctx.deadline && budget(ctx.deadline, Infinity) < SEND_NEEDS_MS) {
          problems.push('The rest were not sent — the run ran out of time. Split this schedule up so each run is smaller.');
          halted = true;
          break;
        }
        if (ctx.stillWanted) {
          let why = null;
          try { why = await ctx.stillWanted(); } catch { why = null; }
          if (why) { stopped = why; halted = true; break; }
        }
        if (Buffer.byteLength(it.html, 'utf8') > MAX_HTML_BYTES) {
          problems.push(`${name}: the report is too large to email.`);
          continue;
        }
        const att = normalizeAttachments(it.attachments);
        if (!att.ok) { problems.push(`${name}: ${att.error}`); continue; }

        if (!firstSend) await sleep(SEND_GAP_MS);
        firstSend = false;
        const sent = await deliverReport({
          label:       def.label,
          projectName: it.projectName,
          recipients:  recips.emails,
          subject:     sched.subject && sched.subject.trim()
            ? (it.projectName && !sched.subject.includes(it.projectName) ? `${sched.subject.trim()} — ${it.projectName}` : sched.subject.trim())
            : it.subject,
          note:        sched.note || '',
          html:        it.html,
          attachments: att.attachments,
          summary:     it.summary,
          attachPdf:   sched.attach_pdf !== false,
          companyName: acct.companyName,
          generatedAt,
          browser,
          logTag:      `schedule=${sched.id} report=${sched.report_type}`,
        });
        if (sent.ok) {
          result.sent++;
          // It went — the PDF just could not be made, so the report is in the body.
          if (sent.warning) notes.push(`${name}: ${sent.warning}`);
        } else {
          problems.push(`${name}: ${sent.error}`);
        }
      }
    }
    if (session.stats.blockedWrites) {
      console.log('[report-schedules] refused', session.stats.blockedWrites, 'page write(s) while building schedule', sched.id);
    }
  } catch (err) {
    problems.push(err.message || 'The run failed.');
  } finally {
    if (session) await session.close();
    if (ownBrowser && browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  result.total = attempted;
  const to = plural(recips.emails.length, 'recipient');
  const tail = [...problems, ...(stopped ? [stopped] : []), ...notes];
  if (result.sent && !problems.length && !stopped) {
    result.status = 'sent';
    result.message = (result.sent === 1 ? `Sent to ${to}.` : `Sent ${result.sent} reports to ${to}.`)
      + (notes.length ? ` ${notes.join('; ')}` : '')
      + (skipped.length ? ` Skipped — ${skipped.join('; ')}` : '');
  } else if (result.sent) {
    result.status = 'partial';
    result.message = `Sent ${result.sent} of ${attempted} to ${to}. ${tail.join('; ')}`;
  } else if (!problems.length && (skipped.length || stopped)) {
    result.status = 'skipped';
    result.message = stopped && !skipped.length ? stopped : `Nothing to send — ${[...skipped, ...(stopped ? [stopped] : [])].join('; ')}`;
  } else {
    result.status = 'failed';
    result.message = tail.length ? tail.join('; ') : 'The page built no report.';
  }
  return result;
}

// ── Claims ──────────────────────────────────────────────────────────────────
// A schedule is being sent while it holds a claim: claimed_at, and a token
// saying whose. Two runs never hold one at once, so a report never goes out
// twice at the same time; a claim older than STALE_CLAIM belongs to a run that
// died, and is free to take.

const occurrenceOf = s => ({
  frequency: s.frequency, days_of_week: s.days_of_week, day_of_month: s.day_of_month,
  send_time: s.send_time, timezone: s.timezone,
});

/** Claim the most overdue schedule that is due and not being sent — or null. */
async function claimNextDue(sql, token) {
  const rows = await sql`
    UPDATE report_schedules SET claimed_at = NOW(), claim_token = ${token}
     WHERE id = (
       SELECT id FROM report_schedules
        WHERE enabled
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
          AND (claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}::interval)
        ORDER BY next_run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
     RETURNING *`;
  return rows[0] || null;
}

/** Claim one schedule for Send now — or null if a run already has it. */
async function claimForSendNow(sql, id, companyCode, token) {
  const rows = await sql`
    UPDATE report_schedules SET claimed_at = NOW(), claim_token = ${token}
     WHERE id = ${id} AND company_code = ${companyCode}
       AND (claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}::interval)
     RETURNING *`;
  return rows[0] || null;
}

/**
 * Start a claimed run: say on the row that it is sending, and — for a
 * timetabled run — move the timetable on to the next occurrence NOW, before
 * anything goes out.
 *
 * Moving it first makes a send at most once. Moved after, as it first was, a
 * run killed partway (the function's time limit, the database blinking under
 * the closing write) left the occurrence still due, and fifteen minutes later
 * the next run sent every email again. Now a cut-off run is simply cut off:
 * it says so ('Interrupted') and the next send is the next occurrence. And
 * nothing after the run touches the timetable, so an edit saved while it ran
 * is the timetable that stands.
 */
async function beginRun(sql, sched, token, { kind, now }) {
  const at = (now || new Date()).toISOString();
  if (kind === 'schedule') {
    const next = T.nextRunAt(occurrenceOf(sched), now || new Date());
    await sql`
      UPDATE report_schedules
         SET next_run_at = ${next ? next.toISOString() : null},
             last_status = 'sending', last_run_at = ${at}, last_message = 'Building and sending.'
       WHERE id = ${sched.id} AND claim_token = ${token}`;
  } else {
    await sql`
      UPDATE report_schedules
         SET last_status = 'sending', last_run_at = ${at}, last_message = 'Building and sending.'
       WHERE id = ${sched.id} AND claim_token = ${token}`;
  }
}

/**
 * Before each send of a timetabled run: is this still the schedule that was
 * claimed? Switched off, deleted or edited while it was being built, it is
 * not sent — "switch it off" must mean nothing more goes out, even to the
 * group it was going to.
 */
async function stillWanted(sql, sched) {
  const rows = await sql`SELECT enabled, updated_at FROM report_schedules WHERE id = ${sched.id}`;
  const r = rows[0];
  if (!r) return 'It was deleted while it was being built, so nothing more was sent.';
  if (!r.enabled) return 'It was switched off while it was being built, so nothing more was sent.';
  if (new Date(r.updated_at).getTime() !== new Date(sched.updated_at).getTime()) {
    return 'It was changed while it was being built, so nothing more was sent; the next run uses the new settings.';
  }
  return null;
}

/**
 * Write a run down: the schedule's last outcome, the history row, and the
 * claim let go of. The timetable is left alone — beginRun has already moved
 * it, and a Send now never moves it: testing Thursday's report on Tuesday
 * must not cancel Wednesday's.
 */
async function recordRun(sql, sched, result, { kind, token, triggeredBy, startedAt, now }) {
  const at = now || new Date();
  const msg = String(result.message || '').slice(0, 2000);
  await sql`
    UPDATE report_schedules
       SET last_run_at = ${at.toISOString()}, last_status = ${result.status}, last_message = ${msg},
           claimed_at  = CASE WHEN claim_token = ${token || ''} THEN NULL ELSE claimed_at END,
           claim_token = CASE WHEN claim_token = ${token || ''} THEN NULL ELSE claim_token END
     WHERE id = ${sched.id}`;
  // What was sent, as it was sent — an edit afterwards must not relabel it.
  await sql`
    INSERT INTO report_schedule_runs
      (schedule_id, company_code, run_kind, status, sent_count, total_count, recipient_count,
       message, triggered_by, started_at, finished_at, report_type, division, project_id, project_name)
    VALUES
      (${sched.id}, ${sched.company_code}, ${kind}, ${result.status}, ${result.sent || 0}, ${result.total || 0},
       ${result.recipientCount || 0}, ${msg}, ${triggeredBy || null},
       ${(startedAt || at).toISOString()}, ${at.toISOString()},
       ${sched.report_type}, ${sched.division}, ${sched.project_id || null}, ${sched.project_name || null})`;
}

/** Let go of a claim with nothing recorded — a run that never started. */
async function releaseClaim(sql, sched, token) {
  await sql`
    UPDATE report_schedules SET claimed_at = NULL, claim_token = NULL
     WHERE id = ${sched.id} AND claim_token = ${token}`;
}

module.exports = {
  runSchedule,
  recordRun,
  beginRun,
  stillWanted,
  claimNextDue,
  claimForSendNow,
  releaseClaim,
  newClaimToken: () => randomUUID(),
  appBaseUrl,
  specFor,
  STALE_CLAIM_MS,
  // for the suite
  buildInBrowser,
  openReportPage,
  loadRunAs,
  recipientsFor,
  nextWorkday,
  MAX_ITEMS,
};
