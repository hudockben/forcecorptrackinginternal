'use strict';
/**
 * GET /api/cron/report-schedules — send the scheduled reports that are due.
 *
 * Runs every five minutes. Each run takes the schedules whose next_run_at has
 * come, sends each one (api/lib/report-schedule-runner.js), writes down how it
 * went, and moves it to its next time. So a report set for 6:30 goes out
 * between 6:30 and 6:35 — the tab says so next to the time picker.
 *
 * Three things about how it does it.
 *
 * It claims before it sends. Two runs can overlap — a slow one still going
 * when the next fires — and both would otherwise see the same 6:30 report as
 * due and send it twice. A schedule is taken by stamping claimed_at in the
 * same statement that picks it, and a run only sends what it claimed. A claim
 * left behind by a run that died goes stale after fifteen minutes and is
 * taken by the next one.
 *
 * It stops before the platform stops it. A function killed at its ceiling
 * leaves claims behind and no record of what went out. This watches the
 * clock, hands back what it has not started, and the next run, five minutes
 * later, picks those up first.
 *
 * Late is not the same as on time. After an outage, a report twelve hours
 * past its time is not sent — a 6:30 Daily PM arriving at 7 PM is noise, and
 * a week's backlog arriving at once is worse. It is written down as missed,
 * and the tab shows it, so nobody wonders where it went.
 */
const { neon } = require('@neondatabase/serverless');
const runner = require('../lib/report-schedule-runner');
const { launchBrowser } = require('../lib/pdf');

// maxDuration is 300s in vercel.json. A run can take a minute or more (a page
// to load, a report per job, a PDF each), so stop starting new ones well
// before the ceiling.
const TIME_BUDGET_MS = 200_000;
// …and the last one started stops sending here, still inside the 300s.
const HARD_STOP_MS   = 275_000;
const MAX_CLAIM      = 20;
const STALE_CLAIM    = '15 minutes';
const MISSED_AFTER_MS = 12 * 3600 * 1000;
const RETAIN_RUNS    = '180 days';

async function runDueSchedules(sql, opts = {}) {
  const t0  = Date.now();
  const out = { claimed: 0, sent: 0, partial: 0, skipped: 0, failed: 0, missed: 0, released: 0 };

  const due = await sql`
    UPDATE report_schedules SET claimed_at = NOW()
     WHERE id IN (
       SELECT id FROM report_schedules
        WHERE enabled
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
          AND (claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}::interval)
        ORDER BY next_run_at
        LIMIT ${MAX_CLAIM}
        FOR UPDATE SKIP LOCKED)
     RETURNING *`;
  out.claimed = due.length;
  if (!due.length) return out;
  due.sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at));

  let browser = null;
  try {
    for (let i = 0; i < due.length; i++) {
      const sched = due[i];
      if (Date.now() - t0 > TIME_BUDGET_MS) {
        const ids = due.slice(i).map(s => s.id);
        await sql`UPDATE report_schedules SET claimed_at = NULL WHERE id = ANY(${ids})`;
        out.released = ids.length;
        break;
      }

      const startedAt = new Date();
      let result;
      if (startedAt - new Date(sched.next_run_at) > MISSED_AFTER_MS) {
        const when = new Date(sched.next_run_at).toLocaleString('en-US', {
          timeZone: sched.timezone || 'America/New_York',
          weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        result = { status: 'missed', sent: 0, total: 0, recipientCount: 0,
          message: `Not sent — it was due ${when}, and was more than 12 hours late by the time the server got to it.` };
      } else {
        // A Chrome that died on the last schedule is replaced, not reused.
        if (browser && browser.connected === false) browser = null;
        if (!browser) {
          try { browser = await (opts.launchBrowser || launchBrowser)(); }
          catch (err) { browser = null; }
        }
        result = await runner.runSchedule(sql, sched, {
          baseUrl: opts.baseUrl, now: startedAt, browser, deadline: t0 + HARD_STOP_MS,
        });
      }
      try {
        await runner.recordRun(sql, sched, result, { kind: 'schedule', triggeredBy: null, startedAt, now: new Date() });
      } catch (err) {
        // Deleted while it was being sent: nothing left to write it on.
        console.error('[report-schedules] could not record schedule', sched.id, err.message);
      }
      out[result.status] = (out[result.status] || 0) + 1;
      console.log('[report-schedules]', 'id=' + sched.id, 'company=' + sched.company_code,
        'report=' + sched.report_type, 'status=' + result.status, 'sent=' + result.sent);
    }
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  try { await sql`DELETE FROM report_schedule_runs WHERE started_at < NOW() - ${RETAIN_RUNS}::interval`; }
  catch (err) { console.error('[report-schedules] prune failed:', err.message); }
  return out;
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[report-schedules] CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'Not configured.' });
  }
  if (String(req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Not configured.' });

  const sql = neon(process.env.DATABASE_URL);
  try {
    const out = await runDueSchedules(sql, { baseUrl: runner.appBaseUrl(req) });
    if (out.claimed) console.log('[report-schedules]', JSON.stringify(out));
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[report-schedules] failed:', err.message);
    return res.status(500).json({ error: 'Run failed.' });
  }
};

module.exports.runDueSchedules = runDueSchedules;
module.exports.MISSED_AFTER_MS = MISSED_AFTER_MS;
