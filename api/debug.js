'use strict';

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');

/**
 * GET /api/debug
 * Health check — confirms env vars are set and DB is reachable.
 * Requires a valid JWT (any role). Never returns company or user data.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require valid JWT — no unauthenticated access
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // CRON_SECRET belongs here for the same reason the others do: without it
  // /api/cron/job-snapshot refuses to run, so the nightly history quietly
  // never gets written. It was the one variable a feature depended on and the
  // one this check omitted, which is how "no history yet" stayed unexplained.
  const checks = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    JWT_SECRET:   !!process.env.JWT_SECRET,
    ADMIN_SECRET: !!process.env.ADMIN_SECRET,
    CRON_SECRET:  !!process.env.CRON_SECRET,
  };

  let dbCheck = null;
  let appDataKeys = null;
  let jobSnapshot = null;
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`SELECT 1`;
      dbCheck = 'ok';
      // Show app_data blob state for trucking keys
      const rows = await sql`
        SELECT key,
               CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) ELSE NULL END AS arr_len,
               jsonb_typeof(value) AS val_type,
               updated_at
        FROM app_data
        WHERE key LIKE '%truck_division%' OR key LIKE '%fct_lists%'
           OR key LIKE '%dust_settings%' OR key LIKE '%dust_lists%'
        ORDER BY key
      `;
      appDataKeys = rows.map(r => ({
        key: r.key,
        arrLen: r.arr_len,
        valType: r.val_type,
        updatedAt: r.updated_at,
      }));

      // Show normalized table row counts for trucking
      try {
        const [normEntries, normUnits, normDrivers, normCustomers] = await Promise.all([
          sql`SELECT COUNT(*) AS n FROM truck_division_entries`,
          sql`SELECT COUNT(*) AS n FROM truck_division_units`,
          sql`SELECT COUNT(*) AS n FROM dropdown_lists WHERE list_name = 'truck_drivers'`,
          sql`SELECT COUNT(*) AS n FROM dropdown_lists WHERE list_name = 'truck_customers'`,
        ]);
        appDataKeys.push({
          _normalizedCounts: {
            truck_division_entries: Number(normEntries[0].n),
            truck_division_units:   Number(normUnits[0].n),
            truck_drivers:          Number(normDrivers[0].n),
            truck_customers:        Number(normCustomers[0].n),
          }
        });
      } catch (e) {
        appDataKeys.push({ _normalizedCountsError: e.message });
      }
    } catch (err) {
      dbCheck = err.message;
    }

    // When the nightly snapshot last wrote, per division, for the caller's own
    // company only. Counts and dates, never a job name or a figure — enough to
    // tell "the cron has never run" from "it ran and found nothing", which
    // previously lived only in Vercel's function logs. Scoped and read the
    // same way api/lib/mathis-digests.js reads it, so what shows up here is
    // what Mathis can see.
    try {
      const sql = neon(process.env.DATABASE_URL);
      const code = String((payload && payload.companyCode) || '').toUpperCase();
      const rows = code ? await sql`
        SELECT division,
               COUNT(*)::int              AS rows,
               COUNT(DISTINCT day)::int   AS days,
               MAX(day)::text             AS last_day
          FROM mathis_job_facts
         WHERE company_code = ${code}
         GROUP BY division
         ORDER BY division
      ` : [];
      jobSnapshot = {
        configured: !!process.env.CRON_SECRET,
        // Two distinct days is the floor a trend needs — see jobHistory() in
        // api/lib/mathis-digests.js. Said here so the answer does not require
        // knowing that rule.
        divisions: rows.map(r => ({
          division: r.division, rows: r.rows, days: r.days,
          lastDay: r.last_day, trendable: r.days >= 2,
        })),
      };
    } catch (err) {
      jobSnapshot = { configured: !!process.env.CRON_SECRET, error: err.message };
    }
  }

  return res.json({ checks, dbCheck, appDataKeys, jobSnapshot });
};
