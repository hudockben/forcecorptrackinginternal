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

// Divisions that carry bid items and a contract value. Trucking, dust and
// quarry have neither jobs nor bids, so a job financials row cannot exist.
const DIVISIONS = [
  { key: 'turf',   name: 'Turf',   read: report.readTurfProjects },
  { key: 'paving', name: 'Paving', read: report.readPavingProjects },
  { key: 'kiewit', name: 'Kiewit', read: report.readKiewitProjects },
];

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function rowsFor(division, projects, fin) {
  return projects.map(p => {
    const f         = (fin && fin.perProject && fin.perProject.get(p.id)) || {};
    const contract  = num(report.projContract(p));
    const bid       = num(f.bid);
    const actual    = num(f.actual);
    const projected = num(f.projected);
    const status    = report.projStatus(p) || '';
    return {
      id:        p.id,
      name:      report.projName(p),
      jobNumber: report.projJob(p) || '',
      division:  division.key,
      divisionName: division.name,
      status,
      inProgress: status === 'In Progress',
      complete:   report.projIsComplete(p),
      contract, bid, actual, projected,
      variance: bid - actual,
      // A job with no contract has no revenue to subtract a cost from, so its
      // profit is unknown rather than negative. null, not 0.
      profit:    contract ? contract - projected : null,
      // Realised profit needs spend behind it as well as a contract; contract
      // minus nothing would post an unstarted job as pure margin.
      actProfit: (contract && actual) ? contract - actual : null,
    };
  });
}

// Same shape as the division home strips: the live figures describe work in
// progress, Actual Profit describes finished work.
function summarise(rows) {
  const live = rows.filter(r => r.inProgress);
  const done = rows.filter(r => r.complete && r.actProfit !== null);
  const sum  = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
  const withContract = live.filter(r => r.profit !== null);
  return {
    activeProjects: live.length,
    totalProjects:  rows.length,
    contract:  sum(live, 'contract'),
    bid:       sum(live, 'bid'),
    actual:    sum(live, 'actual'),
    variance:  sum(live, 'bid') - sum(live, 'actual'),
    projProfit:     withContract.length ? sum(withContract, 'profit') : null,
    projProfitBase: sum(withContract, 'contract'),
    actProfit:      done.length ? sum(done, 'actProfit') : null,
    actProfitBase:  sum(done, 'contract'),
    completedJobs:  done.length,
  };
}

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

  // One division failing must not blank the others — a missing kiewit index is
  // a division with no jobs, not a broken report.
  const perDivision = await Promise.all(DIVISIONS.map(async d => {
    try {
      const projects = (await d.read(sql, company)).filter(Boolean);
      if (!projects.length) return { division: d, projects: [], fin: null };
      const fin = await report.buildFinancials(sql, company, d.key, projects);
      return { division: d, projects, fin };
    } catch (err) {
      console.error(`[executive/financials] ${d.key} failed:`, err.message);
      return { division: d, projects: [], fin: null, error: true };
    }
  }));

  const rows = perDivision.flatMap(({ division, projects, fin }) => rowsFor(division, projects, fin));

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
  });
};
