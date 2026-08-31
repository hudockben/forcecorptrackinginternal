/* Cross-division job financials for the Intercompany ▸ Reports ▸ Financials
   report — every project the company runs, under one roof.
 *
 * Deliberately NOT the executive portfolio. That one is a curated summary:
 * capped at 12 projects, completed work dropped unless pinned, and filtered by
 * a job-number cutoff. This report has to show everything, because Actual
 * Profit is the profit on FINISHED jobs and would otherwise always read zero.
 *
 * The cost logic is reused from report.js rather than reimplemented. Three
 * separate copies of it across the division pages produced three separate bugs
 * (a profit formula that meant different things per division among them), so a
 * fourth copy here would be repeating a known mistake.
 */
const { neon }                           = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const report                             = require('./report');

// The division list and the row/summary shaping live in ../lib/job-financials
// so that anything else answering questions about profit — api/ai/mathis.js
// among them — means exactly what this report means by the word, instead of
// becoming the fourth copy this file's header warns about.
const { JOB_DIVISIONS: DIVISIONS, rowsFor, summarise } = require('../lib/job-financials');

// Only a literal YYYY-MM-DD is accepted. Anything else is treated as absent
// rather than passed down as a half-understood bound, so a malformed date
// widens the report to all time instead of silently reporting on a window
// nobody asked for.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = v => (typeof v === 'string' && ISO_DATE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'))) ? v : null;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  if (!hasDivisionAccess(payload, 'intercompany')) {
    return res.status(403).json({ error: 'You do not have access to the Intercompany Division' });
  }
  if (!payload.companyCode || !process.env.DATABASE_URL) {
    return res.status(200).json({ divisions: [], rows: [], totals: summarise([]) });
  }

  const sql = neon(process.env.DATABASE_URL);
  const company = payload.companyCode;

  // A backwards window would report zero spend everywhere and read as "no work
  // done", so the two bounds are swapped back into order instead.
  let start = asDate(req.query && req.query.start);
  let end   = asDate(req.query && req.query.end);
  if (start && end && start > end) [start, end] = [end, start];
  const ranged = !!(start || end);
  const range  = ranged ? { start, end } : null;

  // One division failing must not blank the others — a missing kiewit index is
  // a division with no jobs, not a broken report.
  const perDivision = await Promise.all(DIVISIONS.map(async d => {
    try {
      const projects = (await d.read(sql, company)).filter(Boolean);
      if (!projects.length) return { division: d, projects: [], fin: null };
      const fin = await report.buildFinancials(sql, company, d.key, projects, range);
      return { division: d, projects, fin };
    } catch (err) {
      console.error(`[executive/financials] ${d.key} failed:`, err.message);
      return { division: d, projects: [], fin: null, error: true };
    }
  }));

  const rows = perDivision.flatMap(({ division, projects, fin }) => rowsFor(division, projects, fin, ranged));

  res.status(200).json({
    divisions: perDivision.map(({ division, projects, error }) => ({
      key:  division.key,
      name: division.name,
      error: !!error,
      ...summarise(rows.filter(r => r.division === division.key)),
      jobs: projects.length,
    })),
    rows,
    totals: summarise(rows),
    // Echoed back so the report labels itself with the window the figures were
    // actually built from, not the one the client believes it asked for.
    range: ranged ? { start, end } : null,
  });
};
