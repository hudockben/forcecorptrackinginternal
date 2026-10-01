'use strict';
/**
 * GET /api/cron/report-schedules — send the scheduled reports that are due.
 *
 * Runs every five minutes. Each run takes due schedules one at a time, sends
 * each (api/lib/report-schedule-runner.js), and writes down how it went. So a
 * report set for 6:30 goes out between 6:30 and 6:35 — the tab says so next to
 * the time picker, which only offers five-minute marks.
 *
 * How it does it, and why.
 *
 * One at a time, claimed just before it runs. A batch claimed up front ran
 * each schedule from a snapshot up to a few minutes old — one switched off or
 * re-pointed at another group in the meantime still went out as it was.
 * Claiming stamps claimed_at and a token in the statement that picks the row,
 * so two overlapping runs never take the same one.
 *
 * At most once. The claimed occurrence is marked taken (the timetable moves to
 * the next one) before anything is sent. A run killed partway — the function's
 * time limit, a crash — leaves a report cut short and says 'Interrupted'; it
 * does not leave the occurrence due, to be sent again in full fifteen minutes
 * later to people who already have half of it.
 *
 * It stops before the platform stops it. It starts no new schedule after
 * TIME_BUDGET_MS, and the one it is on stops sending at HARD_STOP_MS, inside
 * the 300 seconds the function gets.
 *
 * What does not fit waits for the next pass. A schedule cut short by that
 * stop — fifteen Daily PMs where the time allows eleven — hands the rest of
 * its occurrence back (runner.handBack): due again at once, with the jobs
 * already sent written down so the next pass, five minutes on, sends only the
 * other four. So does one that ran out of time before it sent anything, and
 * one saved over while it was sending (the rest go with the new settings).
 * Each schedule is taken once per pass, so one handed back waits its turn.
 *
 * Late is not the same as on time. After an outage, a report twelve hours past
 * its time is not sent — a 6:30 Daily PM arriving at 7 PM is noise, and a
 * week's backlog arriving at once is worse. It is written down as missed, and
 * the tab shows it, so nobody wonders where it went.
 */
const { neon } = require('@neondatabase/serverless');
const runner = require('../lib/report-schedule-runner');
const { launchBrowser } = require('../lib/pdf');

const TIME_BUDGET_MS  = 150_000;   // start no new schedule after this
const HARD_STOP_MS    = 285_000;   // the one running stops sending here
const MISSED_AFTER_MS = 12 * 3600 * 1000;
const RETAIN_RUNS     = '180 days';

async function runDueSchedules(sql, opts = {}) {
  const t0  = Date.now();
  const out = { claimed: 0, sent: 0, partial: 0, skipped: 0, failed: 0, missed: 0, continuing: 0 };
  let browser = null;
  const taken = [];   // this pass's schedules, each taken once
  try {
    while (Date.now() - t0 < TIME_BUDGET_MS) {
      const token = runner.newClaimToken();
      const sched = await runner.claimNextDue(sql, token, taken);
      if (!sched) break;
      taken.push(sched.id);
      out.claimed++;

      const startedAt = new Date();
      const dueAt = new Date(sched.next_run_at);
      let started;
      try {
        started = await runner.beginRun(sql, sched, token, { kind: 'schedule', now: startedAt });
      } catch (err) {
        // Nothing sent and nothing moved: hand it back for the next run.
        console.error('[report-schedules] could not start schedule', sched.id, err.message);
        try { await runner.releaseClaim(sql, sched, token); } catch { /* goes stale instead */ }
        break;
      }
      if (!started) {
        // Saved between the claim and here: its timetable is the one just
        // saved, not the one claimed. The next pass takes it as it now is.
        try { await runner.releaseClaim(sql, sched, token); } catch { /* goes stale instead */ }
        out.claimed--;
        continue;
      }

      let result;
      if (startedAt - dueAt > MISSED_AFTER_MS) {
        const when = dueAt.toLocaleString('en-US', {
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
          baseUrl:     opts.baseUrl,
          now:         startedAt,
          occurrence:  dueAt,
          browser,
          deadline:    t0 + HARD_STOP_MS,
          stillWanted: () => runner.stillWanted(sql, sched),
          resume:      sched.resume_state,
          handBack:    ({ state, progress }) => runner.handBack(sql, sched, token, { occurrence: dueAt, state, progress }),
        });
      }
      try {
        await runner.recordRun(sql, sched, result, { kind: 'schedule', token, triggeredBy: null, startedAt, now: new Date() });
      } catch (err) {
        // Deleted while it ran, or the database blinked. The occurrence is
        // already marked taken, so this costs the record, never a resend.
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
