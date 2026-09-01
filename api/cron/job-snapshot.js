'use strict';
/**
 * GET /api/cron/job-snapshot — one row per job per day, for every company.
 *
 * Everything else Mathis reads is a snapshot of now, so "how has profit
 * trended" had no answer that was not invented. This writes the history that
 * question needs.
 *
 * Three things about how it does it.
 *
 * It recomputes NOTHING. The figures come from report.buildFinancials and
 * jobFin.rowsFor — the same two calls the live digest makes, which are the
 * same arithmetic the division page runs. A snapshot job with its own SQL
 * would drift from the page within a release, and a trend built on a drifting
 * figure is worse than no trend at all.
 *
 * It is idempotent by day. The natural key is (company, division, project,
 * day) and the write is an upsert, so a cron that fires twice, a retry, or a
 * manual catch-up all overwrite rather than fabricating a second data point
 * for a day that already has one.
 *
 * It stops before the platform stops it. A serverless function killed at its
 * duration ceiling leaves a half-written night with no record of where it got
 * to. This watches the clock, finishes the company it is in, and reports what
 * it did — a partial snapshot that says it is partial beats a timeout.
 */
const { neon } = require('@neondatabase/serverless');
const report   = require('../executive/report');
const jobFin   = require('../lib/job-financials');

// Every project of every company, so the window is not the twelve rows a chat
// digest reads. A company with more jobs than this has a bigger problem than
// its trend data.
const MAX_PROJECTS = 500;

// Vercel kills the function at maxDuration (60s, set in vercel.json). Stop
// well before that: the last company started must be able to finish.
const TIME_BUDGET_MS = 45000;

// Rows older than this go. 400 days keeps a full year plus room to compare
// against the same point last season; keeping everything forever is how a
// convenience table becomes a migration.
const RETAIN_DAYS = 400;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Snapshot one division of one company.
 *
 * Returns the number of jobs written. A division a company does not run reads
 * as an empty project index and writes nothing, which is correct and needs no
 * special case — the company's allowed_divisions are not consulted, because a
 * division switched off today should not silently erase the history of the
 * work it did last month.
 */
async function snapshotDivision(sql, companyCode, division, day) {
  const div = jobFin.jobDivision(division);
  if (!div) return 0;

  const projects = (await div.read(sql, companyCode, { limit: MAX_PROJECTS })).filter(Boolean);
  if (!projects.length) return 0;

  const fin  = await report.buildFinancials(sql, companyCode, division, projects, null);
  const rows = jobFin.rowsFor(div, projects, fin, false);

  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r  = rows[i];
    // rowsFor preserves the order of `projects`, so the project at the same
    // index is this row's. Matching by name instead would collapse two jobs a
    // PM gave the same name, which is a thing PMs do.
    const id = String((projects[i] && projects[i].id) || '');
    if (!id) continue;

    await sql`
      INSERT INTO mathis_job_facts (
        company_code, division, project_id, day,
        job_name, job_number, status, complete,
        contract, bid, actual_cost, projected_cost, variance,
        projected_profit, actual_profit, captured_at
      ) VALUES (
        ${companyCode}, ${division}, ${id}, ${day},
        ${String(r.name || '').slice(0, 200)},
        ${String(r.jobNumber || '').slice(0, 40)},
        ${String(r.status || '').slice(0, 40)},
        ${!!r.complete},
        ${num(r.contract)}, ${num(r.bid)}, ${num(r.actual)},
        ${num(r.projected)}, ${num(r.variance)},
        ${r.profit === null ? null : num(r.profit)},
        ${r.actProfit === null ? null : num(r.actProfit)},
        NOW()
      )
      ON CONFLICT (company_code, division, project_id, day) DO UPDATE SET
        job_name         = EXCLUDED.job_name,
        job_number       = EXCLUDED.job_number,
        status           = EXCLUDED.status,
        complete         = EXCLUDED.complete,
        contract         = EXCLUDED.contract,
        bid              = EXCLUDED.bid,
        actual_cost      = EXCLUDED.actual_cost,
        projected_cost   = EXCLUDED.projected_cost,
        variance         = EXCLUDED.variance,
        projected_profit = EXCLUDED.projected_profit,
        actual_profit    = EXCLUDED.actual_profit,
        captured_at      = NOW()
    `;
    written++;
  }
  return written;
}

/**
 * Run the whole sweep. Exported so scripts/test-mathis.js can drive it with a
 * recording sql rather than reaching through an HTTP handler for it.
 */
async function runSnapshot(sql, { day, now = () => Date.now(), budgetMs = TIME_BUDGET_MS } = {}) {
  const started = now();
  const today = day || new Date().toISOString().slice(0, 10);

  const companies = await sql`SELECT code FROM companies ORDER BY code`;
  const result = {
    day: today, companies: 0, jobs: 0, divisions: 0,
    skippedCompanies: 0, truncated: false, errors: [],
  };

  for (const c of companies) {
    const code = c && c.code;
    if (!code) continue;

    // Checked between companies, never inside one: a company half-snapshotted
    // is a company whose divisions disagree about what day it is.
    if (now() - started > budgetMs) {
      result.truncated = true;
      result.skippedCompanies = companies.length - result.companies;
      break;
    }

    let jobsHere = 0;
    // JOB_DIVISIONS carries {key, name} objects, not keys. Reading it as a
    // list of strings snapshotted nothing and reported success doing it.
    for (const division of jobFin.JOB_DIVISIONS.map(d => d.key)) {
      try {
        const n = await snapshotDivision(sql, code, division, today);
        if (n) { jobsHere += n; result.divisions++; }
      } catch (err) {
        // One division's blob being unreadable must not cost the other
        // fourteen companies their night. Recorded and carried past.
        console.error(`[job-snapshot] ${code}/${division} failed:`, err.message);
        result.errors.push(`${code}/${division}: ${String(err.message).slice(0, 200)}`);
      }
    }
    result.companies++;
    result.jobs += jobsHere;
  }

  // Purge last, and only on a complete sweep. Deleting history at the end of a
  // run that ran out of time is how a bad night becomes a lost year.
  if (!result.truncated) {
    try {
      const gone = await sql`
        DELETE FROM mathis_job_facts
         WHERE day < CURRENT_DATE - ${RETAIN_DAYS}::integer
      `;
      result.purged = (gone && gone.count) || 0;
    } catch (err) {
      console.error('[job-snapshot] purge failed:', err.message);
      result.errors.push(`purge: ${String(err.message).slice(0, 200)}`);
    }
  }

  return result;
}

/**
 * Vercel's scheduler calls this with `Authorization: Bearer $CRON_SECRET`.
 *
 * Without the secret set, the endpoint refuses rather than running open. It
 * reads every company's project blobs and writes to every company's history —
 * an unauthenticated GET that does that is a denial-of-service button with a
 * public URL, and the shape of the response would leak how many companies
 * exist besides.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[job-snapshot] CRON_SECRET is not set — refusing to run');
    return res.status(503).json({ error: 'Snapshot is not configured.' });
  }
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Snapshot is not configured.' });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const out = await runSnapshot(sql, {});
    console.log('[job-snapshot]', JSON.stringify(out));
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('[job-snapshot] sweep failed:', err.message);
    return res.status(500).json({ error: 'Snapshot failed.' });
  }
};

module.exports.runSnapshot     = runSnapshot;
module.exports.snapshotDivision = snapshotDivision;
module.exports.MAX_PROJECTS    = MAX_PROJECTS;
module.exports.RETAIN_DAYS     = RETAIN_DAYS;
module.exports.TIME_BUDGET_MS  = TIME_BUDGET_MS;
