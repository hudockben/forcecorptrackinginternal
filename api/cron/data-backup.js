'use strict';
/**
 * GET /api/cron/data-backup — the nightly copy of every company's saved data,
 * and the check that emails when a list shrinks. The work is in
 * api/lib/data-backup.js.
 *
 * Runs before the working day (vercel.json), so a list emptied during
 * yesterday's work is in someone's inbox before today's is saved on top of it.
 *
 * Alerts go to DATA_ALERT_EMAILS, a comma-separated list set in the project's
 * environment. Without it the backup and the check still run, and the drops
 * they find are in the response and the log, but nobody is emailed.
 */
const { neon } = require('@neondatabase/serverless');
const { runDataBackup } = require('../lib/data-backup');

/**
 * Vercel's scheduler calls this with `Authorization: Bearer $CRON_SECRET`.
 *
 * Without the secret set, the endpoint refuses rather than running open: it
 * reads and copies every company's data, and its answer says which companies
 * lost what.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[data-backup] CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'Backup is not configured.' });
  }
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Backup is not configured.' });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const out = await runDataBackup(sql, {});
    const logged = { ...out, alerts: out.alerts.map(a => ({ company: a.company, since: a.since, drops: a.drops })) };
    if (out.alerts.length) console.warn('[data-backup] lists shrank:', JSON.stringify(logged.alerts));
    console.log('[data-backup]', JSON.stringify({ day: out.day, backup: out.backup, measures: out.measures,
      alerts: out.alerts.length, emailed: out.emailed, errors: out.errors }));
    return res.status(200).json({ ok: true, ...logged });
  } catch (err) {
    console.error('[data-backup] run failed:', err.message);
    return res.status(500).json({ error: 'Backup failed.' });
  }
};
