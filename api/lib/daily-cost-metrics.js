'use strict';
/**
 * What a daily row cost, split the way the people asking about it split it.
 *
 * A PORT of tracker.html's calcDaily. The page costs a daily row's equipment
 * as `equip_total_override || (equip_unit_cost * equip_hours)`, and the `||`
 * is load-bearing: an imported CSV row arrives with the total already
 * multiplied out, and multiplying it again is how a $900 day becomes $8,100.
 * A zero override falls through to the multiplication, which is why this is
 * `||` and not a null check — copied deliberately rather than tidied.
 *
 * Nothing here is a second opinion about money. These totals are ALREADY
 * inside each job's actual cost — daily rows are what actual cost is made of.
 * This breaks that number down by machine and by person; it never adds to it.
 * scripts/test-mathis.js pins the arithmetic against the page's own function.
 *
 * calcDaily's labor half reads a browser-only preview toggle: with `pvPreview`
 * active every row is recosted at one what-if prevailing rate. That is a
 * sandbox a user opts into on their own screen, never a fact about the job, so
 * the port omits it — a row is costed at the rate it was actually written with.
 */

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** What one daily row's equipment cost, exactly as the page computes it. */
function rowEquipCost(row) {
  if (!row || typeof row !== 'object') return 0;
  return num(row.equip_total_override) || (num(row.equip_unit_cost) * num(row.equip_hours));
}

/**
 * Roll the daily rows of several projects up by machine.
 *
 * `nameOf` turns a project into the name a person would recognise, so a
 * machine can say which jobs it ran on instead of listing project ids.
 *
 * Rows carrying no equipment name are skipped rather than pooled under a
 * blank: a labor row is not an unnamed machine, and a "(none)" bucket holding
 * most of the hours reads as one.
 */
function equipmentUsage(projects, nameOf) {
  const by = new Map();
  let totalHours = 0, totalCost = 0;

  for (const p of Array.isArray(projects) ? projects : []) {
    const job  = nameOf ? nameOf(p) : null;
    const rows = p && Array.isArray(p.dailyRows) ? p.dailyRows : [];
    for (const r of rows) {
      const name = String((r && r.equipment) || '').trim();
      if (!name) continue;
      const hours = num(r.equip_hours);
      const cost  = rowEquipCost(r);
      if (!hours && !cost) continue;
      let e = by.get(name);
      if (!e) by.set(name, (e = { name, hours: 0, cost: 0, jobs: new Set() }));
      e.hours += hours;
      e.cost  += cost;
      if (job) e.jobs.add(job);
      totalHours += hours;
      totalCost  += cost;
    }
  }

  const round2 = v => Math.round(v * 100) / 100;
  const rows = [...by.values()]
    .map(e => ({ name: e.name, hours: round2(e.hours), cost: round2(e.cost), jobs: [...e.jobs] }))
    .sort((a, b) => b.hours - a.hours || b.cost - a.cost);

  return { rows, totalHours: round2(totalHours), totalCost: round2(totalCost) };
}

/**
 * What one daily row's labor cost, as the page computes it with its
 * prevailing-wage preview switched off.
 *
 * The rate is the one stored ON THE ROW, not the employee's rate today.
 * tracker.html writes it at entry from the employee's prevailing or
 * non-prevailing rate depending on the job, so a row from last season keeps
 * what it was actually costed at — and re-deriving it from today's roster
 * would quietly restate a closed job.
 */
function rowLaborCost(row) {
  if (!row || typeof row !== 'object') return 0;
  return num(row.rate) * num(row.labor_hours);
}

/**
 * Roll the daily rows of several projects up by person.
 *
 * Same shape as equipmentUsage and the same reasons: rows with no name are
 * skipped rather than pooled, and each person carries the jobs they appeared
 * on so "who worked on Atwood" is answerable without a second read.
 */
function laborUsage(projects, nameOf) {
  const by = new Map();
  let totalHours = 0, totalCost = 0;

  for (const p of Array.isArray(projects) ? projects : []) {
    const job  = nameOf ? nameOf(p) : null;
    const rows = p && Array.isArray(p.dailyRows) ? p.dailyRows : [];
    for (const r of rows) {
      const name = String((r && r.employee) || '').trim();
      if (!name) continue;
      const hours = num(r.labor_hours);
      const cost  = rowLaborCost(r);
      if (!hours && !cost) continue;
      let e = by.get(name);
      if (!e) by.set(name, (e = { name, hours: 0, cost: 0, jobs: new Set() }));
      e.hours += hours;
      e.cost  += cost;
      if (job) e.jobs.add(job);
      totalHours += hours;
      totalCost  += cost;
    }
  }

  const round2 = v => Math.round(v * 100) / 100;
  const rows = [...by.values()]
    .map(e => ({ name: e.name, hours: round2(e.hours), cost: round2(e.cost), jobs: [...e.jobs] }))
    .sort((a, b) => b.hours - a.hours || b.cost - a.cost);

  return { rows, totalHours: round2(totalHours), totalCost: round2(totalCost) };
}

module.exports = { rowEquipCost, equipmentUsage, rowLaborCost, laborUsage };
