'use strict';
/* Job financials — the one place a project row and a portfolio summary are
 * shaped, for every division that runs jobs (turf, paving, kiewit).
 *
 * This used to live inside api/executive/financials.js as two module-private
 * functions. It moved here the moment a second caller needed it, because the
 * alternative — a second copy — is the exact mistake that file's own header
 * warns about: three copies of the cost logic across the division pages
 * produced three bugs, one of which made the profit column mean different
 * things on different pages. Mathis (api/ai/mathis.js) answers questions about
 * profit in plain English, so it must mean by "profit" precisely what the
 * Financials tab means, or the assistant and the page it sits on will disagree
 * in front of a customer.
 *
 * The cost and projection arithmetic still belongs to api/executive/report.js
 * (buildFinancials / projContract / projBidLines). Nothing here reimplements
 * it; this module only reads its output and shapes rows.
 */

const report = require('../executive/report');

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The divisions that carry bid items and a contract value. Trucking, dust and
// quarry have neither jobs nor bids, so a job financials row cannot exist for
// them — asking Mathis for "profit on the last 5 trucking jobs" has no answer
// in this shape, and it must say so rather than substitute revenue.
const JOB_DIVISIONS = [
  { key: 'turf',   name: 'Turf',   read: report.readTurfProjects   },
  { key: 'paving', name: 'Paving', read: report.readPavingProjects },
  { key: 'kiewit', name: 'Kiewit', read: report.readKiewitProjects },
];

const jobDivision = key => JOB_DIVISIONS.find(d => d.key === key) || null;

/**
 * One row per project. `fin` is the object api/executive/report.js
 * buildFinancials() returns; `ranged` says whether a date window was asked
 * for, and only then do the windowed figures appear — a client that sent no
 * dates must not be able to mistake a lifetime figure for a windowed one.
 */
function rowsFor(division, projects, fin, ranged) {
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
      // Only present when a window was asked for, so a client that sent no
      // dates cannot mistake a lifetime figure for a windowed one.
      ...(ranged ? { rangeActual: num(f.rangeActual), rangeRows: num(f.rangeRows) } : {}),
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
  const ranged = rows.some(r => r.rangeActual !== undefined);
  return {
    // Windowed spend totals every job that booked cost in the window, not just
    // the live ones — money spent on a job that has since finished was still
    // spent in that period.
    ...(ranged ? { rangeActual: sum(rows, 'rangeActual'),
                   rangeJobs:   rows.filter(r => (r.rangeRows || 0) > 0).length } : {}),
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

module.exports = { num, JOB_DIVISIONS, jobDivision, rowsFor, summarise };
