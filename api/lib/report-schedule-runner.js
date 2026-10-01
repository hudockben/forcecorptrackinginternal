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

const jwt = require('jsonwebtoken');
const { currentAccess } = require('./auth');
const { MAX_HTML_BYTES, MAX_RECIPIENTS, isValidEmail, normalizeAttachments } = require('./email');
const { launchBrowser } = require('./pdf');
const { deliverReport } = require('./report-delivery');
const { SCHEDULABLE, DIVISIONS, PAY_RANGES, mayUseDivision } = require('./report-catalog');
const T = require('./report-schedule-time');

// How long a page gets to load its data and build. The big job pages pull
// every project, every daily row and every list before they can answer.
const PAGE_LOAD_MS  = 45_000;
const BUILD_MS      = 120_000;
// Resend allows a couple of requests a second; an "every In Progress job"
// schedule sends one email per job, back to back.
const SEND_GAP_MS   = 600;
// A job-by-job schedule over a company's whole active list could run past the
// function's time limit. This many is well inside it, and a company with more
// active jobs than this should be splitting the schedule up anyway.
const MAX_ITEMS     = 40;

// The POSTs that are questions rather than writes. The Daily PM report's AI
// read of a job goes out as a POST; it saves nothing but its own once-a-day
// answer cache, and without it the scheduled copy would be missing the block
// the button's copy has.
const READ_ONLY_POSTS = new Set(['/api/ai/schedule-analysis']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function divisionName(key) {
  const d = DIVISIONS.find(x => x.key === key);
  return d ? d.name : key;
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

/** Every address on the schedule's groups, de-duplicated, plus what was missing. */
async function recipientsFor(sql, companyCode, groupIds) {
  const ids = (Array.isArray(groupIds) ? groupIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { emails: [], groups: [], missing: 0 };
  const rows = await sql`
    SELECT id, name, emails FROM report_recipient_groups
     WHERE company_code = ${companyCode} AND id = ANY(${ids})`;
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
  return { emails: emails.slice(0, MAX_RECIPIENTS), groups: rows.map(g => g.name), missing: ids.length - rows.length };
}

/**
 * What the page is asked to build: the report, the job (or every In Progress
 * job), and the dates the schedule's period means right now in its zone.
 */
function specFor(sched, def, now) {
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

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

/**
 * Open `def.page` as `acct` and ask it for the report.
 * Resolves to { items, skipped, errors, blockedWrites } or throws in words.
 */
async function buildInBrowser(browser, { baseUrl, def, acct, spec }) {
  if (!baseUrl) throw new Error('The server does not know its own address (set APP_BASE_URL).');
  const origin = new URL(baseUrl).origin;
  const context = await browser.createBrowserContext();
  let blockedWrites = 0;
  const pageErrors = [];
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_LOAD_MS);
    await page.setViewport({ width: 1440, height: 900 });
    // The page's "today" is the office's today: a report the schedule sends
    // at 9 PM Eastern must not be built for tomorrow because the server's
    // clock is already past midnight UTC.
    try { await page.emulateTimezone(spec.timezone); } catch { /* keep the server's */ }
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': bypass });

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
          if (read || READ_ONLY_POSTS.has(u.pathname)) return req.continue();
          blockedWrites++;
          return req.abort('accessdenied');
        }
        // The pages pull a few libraries and fonts from CDNs. Reads only, and
        // only the kinds of thing a page renders with.
        if (read && ['script', 'stylesheet', 'font', 'image'].includes(req.resourceType())) return req.continue();
        return req.abort();
      } catch { /* already handled */ }
    });
    // An alert() would hang the page forever with nobody to click OK.
    page.on('dialog', d => { d.dismiss().catch(() => {}); });
    page.on('pageerror', err => { if (pageErrors.length < 5) pageErrors.push(String(err && err.message || err)); });

    const user = {
      username:         acct.username,
      companyCode:      acct.companyCode,
      companyName:      acct.companyName,
      role:             acct.role,
      divisionRoles:    acct.divisionRoles,
      allowedDivisions: acct.allowedDivisions,
      isPlatformAdmin:  acct.isPlatformAdmin,
    };
    await page.evaluateOnNewDocument((appOrigin, ls, readOnlyPosts) => {
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
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (!READS.includes(method) && !allowed(url)) {
          return Promise.reject(new TypeError('Scheduled report runs are read-only.'));
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
    }, [...READ_ONLY_POSTS]);

    const target = `${baseUrl}/${def.page}?autoreport=1`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_MS });

    try {
      await page.waitForFunction(
        t => window.dwAutoReport && window.dwAutoReport.has(t),
        { timeout: PAGE_LOAD_MS, polling: 250 }, spec.type);
    } catch {
      const where = (() => { try { return new URL(page.url()).pathname; } catch { return ''; } })();
      if (!where.endsWith('/' + def.page)) {
        throw new Error(`The ${divisionName(def.division)} page sent ${acct.username} away (to ${where || 'another page'}) instead of opening.`);
      }
      throw new Error(`The ${divisionName(def.division)} page did not offer this report`
        + (pageErrors.length ? ` — it hit an error: ${pageErrors[0]}` : '.'));
    }

    const out = await withTimeout(
      page.evaluate(s => window.dwAutoReport.build(s), spec),
      BUILD_MS, 'Building the report');
    return { ...out, blockedWrites, pageErrors };
  } finally {
    try { await context.close(); } catch { /* already gone */ }
  }
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/**
 * Run one schedule now.
 *
 *   runSchedule(sql, sched, {
 *     now, baseUrl,
 *     browser?,      // a running Chrome to share; otherwise one is launched
 *     deadline?,     // epoch ms: send nothing more after this
 *   })
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

  const spec = specFor(sched, def, now);

  let browser = ctx.browser || null;
  const ownBrowser = !browser;
  try {
    if (!browser) {
      try { browser = await launchBrowser(); }
      catch (err) { return fail(`Could not start the report browser: ${err.message}`); }
    }

    let built;
    try {
      built = await buildInBrowser(browser, { baseUrl: ctx.baseUrl, def, acct, spec });
    } catch (err) {
      return fail(err.message || 'The report could not be built.');
    }

    const items  = (built.items || []).slice(0, MAX_ITEMS);
    const capped = (built.items || []).length - items.length;
    const problems = (built.errors || []).map(e => `${e.projectName || 'Report'}: ${e.error}`);
    result.total = items.length + (built.errors || []).length;

    const tz = spec.timezone;
    const generatedAt = now.toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    let outOfTime = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = it.projectName || def.label;
      // The function is killed at its ceiling; stop with a record of what
      // went rather than be cut off mid-send with none.
      if (ctx.deadline && Date.now() > ctx.deadline) { outOfTime = items.length - i; break; }
      if (Buffer.byteLength(it.html, 'utf8') > MAX_HTML_BYTES) {
        problems.push(`${name}: the report is too large to email.`);
        continue;
      }
      const att = normalizeAttachments(it.attachments);
      if (!att.ok) { problems.push(`${name}: ${att.error}`); continue; }

      if (i > 0) await sleep(SEND_GAP_MS);
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
        if (sent.warning) problems.push(`${name}: ${sent.warning}`);
      } else {
        problems.push(`${name}: ${sent.error}`);
      }
    }
    if (outOfTime > 0) problems.push(`${outOfTime} more not sent — the run ran out of time. Split this schedule up, or send the rest with Send now.`);
    if (capped > 0) problems.push(`${capped} more job${capped === 1 ? '' : 's'} not sent — a schedule sends at most ${MAX_ITEMS} at once.`);

    const skipped = (built.skipped || []).map(s => s.projectName ? `${s.projectName}: ${s.why}` : s.why);
    const to = plural(recips.emails.length, 'recipient');

    if (result.sent && !problems.length) {
      result.status = 'sent';
      result.message = result.sent === 1 ? `Sent to ${to}.` : `Sent ${result.sent} reports to ${to}.`;
      if (skipped.length) result.message += ` Skipped — ${skipped.join('; ')}`;
    } else if (result.sent) {
      result.status = 'partial';
      result.message = `Sent ${result.sent} of ${result.total + capped} to ${to}. ${problems.join('; ')}`;
    } else if (!problems.length && skipped.length) {
      result.status = 'skipped';
      result.message = `Nothing to send — ${skipped.join('; ')}`;
    } else {
      result.status = 'failed';
      result.message = problems.length ? problems.join('; ') : 'The page built no report.';
    }
    if (built.blockedWrites) {
      console.log('[report-schedules] refused', built.blockedWrites, 'page write(s) while building schedule', sched.id);
    }
    return result;
  } catch (err) {
    return fail(err.message || 'The run failed.');
  } finally {
    if (ownBrowser && browser) { try { await browser.close(); } catch { /* already gone */ } }
  }
}

/**
 * Write a run down: the schedule's last outcome, the history row, and — for a
 * timetabled run — when it goes next. A "Send now" leaves the timetable alone:
 * testing Thursday's report on Tuesday must not cancel Wednesday's.
 */
async function recordRun(sql, sched, result, { kind, triggeredBy, startedAt, now }) {
  const at = now || new Date();
  const msg = String(result.message || '').slice(0, 2000);
  if (kind === 'schedule') {
    const occ = {
      frequency: sched.frequency, days_of_week: sched.days_of_week, day_of_month: sched.day_of_month,
      send_time: sched.send_time, timezone: sched.timezone,
    };
    const next = T.nextRunAt(occ, at);
    await sql`
      UPDATE report_schedules
         SET last_run_at = ${at.toISOString()}, last_status = ${result.status}, last_message = ${msg},
             next_run_at = ${next ? next.toISOString() : null}, claimed_at = NULL
       WHERE id = ${sched.id}`;
  } else {
    await sql`
      UPDATE report_schedules
         SET last_run_at = ${at.toISOString()}, last_status = ${result.status}, last_message = ${msg}
       WHERE id = ${sched.id}`;
  }
  await sql`
    INSERT INTO report_schedule_runs
      (schedule_id, company_code, run_kind, status, sent_count, total_count, recipient_count,
       message, triggered_by, started_at, finished_at)
    VALUES
      (${sched.id}, ${sched.company_code}, ${kind}, ${result.status}, ${result.sent || 0}, ${result.total || 0},
       ${result.recipientCount || 0}, ${msg}, ${triggeredBy || null},
       ${(startedAt || at).toISOString()}, ${at.toISOString()})`;
}

module.exports = {
  runSchedule,
  recordRun,
  appBaseUrl,
  specFor,
  // for the suite
  buildInBrowser,
  loadRunAs,
  recipientsFor,
  nextWorkday,
  MAX_ITEMS,
};
