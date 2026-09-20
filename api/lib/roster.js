'use strict';
/**
 * The company's people, as ONE definition.
 *
 * A name can live in four places, because each division brought its own roster
 * with it:
 *
 *   - `employees`                          canonical (turf / dust / trucking)
 *   - `<company>:fct_paving_lists`         paving's blob
 *   - `<company>:fct_kiewit_lists`         kiewit's blob
 *   - `quarry_employees`                   quarry's table
 *
 * The "Manage employees" list has always shown the union of all four. The
 * Scheduler used to read only the first and then fold in any name it found on
 * a project's daily rows, which meant the two lists disagreed in BOTH
 * directions: the Scheduler offered people nobody could find in Manage (a name
 * off an old daily row, someone since removed from the roster, a typo), and it
 * was missing anyone who only exists on the paving, kiewit or quarry list and
 * has not worked a job yet.
 *
 * So the union lives here and both callers read it. A name is a name once:
 * matching is case-insensitive, and the first source to claim it wins, which
 * keeps the canonical table's job class, rates, role flags and contact card
 * ahead of a bare blob entry.
 *
 * Every non-canonical source is read inside its own try/catch: a division blob
 * that has never been written must not take the roster down with it.
 */

function blankRow(name, source, jobClass) {
  return {
    id:                  null,
    name,
    job_class:           jobClass || null,
    prevailing_rate:     null,
    non_prevailing_rate: null,
    is_supervisor:       false,
    is_driver:           false,
    phone:               null,
    email:               null,
    supervisor_name:     null,
    source,
  };
}

// Blob rosters hold either bare strings or {name, job_class} objects.
function addBlobList(byName, list, source) {
  for (const e of list || []) {
    const raw = (typeof e === 'string' ? e : (e && e.name)) || '';
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, blankRow(name, source, typeof e === 'object' ? e.job_class : null));
  }
}

async function readBlobEmployees(sql, key) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${key}`;
  return (rows.length && rows[0].value && Array.isArray(rows[0].value.employees)) ? rows[0].value.employees : [];
}

/**
 * Every person on the company's books, deduplicated by name.
 * Rows carry the same shape GET /api/employees has always returned.
 */
async function readEmployeeRoster(sql, companyCode) {
  const byName = new Map(); // lowercased name → row

  const tableRows = await sql`
    SELECT id, name, job_class,
           pw_rate       AS prevailing_rate,
           non_pw_rate   AS non_prevailing_rate,
           is_supervisor,
           is_driver,
           phone,
           email,
           supervisor_name,
           sort_order
    FROM   employees
    WHERE  company_code = ${companyCode} AND active = TRUE
    ORDER  BY sort_order ASC, name ASC
  `;
  for (const r of tableRows) {
    const name = (r.name || '').trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), {
      id:                  r.id,
      name,
      job_class:           r.job_class || null,
      prevailing_rate:     r.prevailing_rate,
      non_prevailing_rate: r.non_prevailing_rate,
      is_supervisor:       r.is_supervisor === true,
      is_driver:           r.is_driver === true,
      phone:               r.phone || null,
      email:               r.email || null,
      supervisor_name:     r.supervisor_name || null,
      source:              'employees',
    });
  }

  try { addBlobList(byName, await readBlobEmployees(sql, companyCode + ':fct_paving_lists'), 'paving'); }
  catch (err) { console.error('[roster] paving blob read failed (non-fatal):', err.message); }

  try { addBlobList(byName, await readBlobEmployees(sql, companyCode + ':fct_kiewit_lists'), 'kiewit'); }
  catch (err) { console.error('[roster] kiewit blob read failed (non-fatal):', err.message); }

  try {
    const qRows = await sql`SELECT name FROM quarry_employees WHERE company_code = ${companyCode}`;
    for (const r of qRows) {
      const name = (r.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (byName.has(key)) continue;
      byName.set(key, blankRow(name, 'quarry'));
    }
  } catch (err) { console.error('[roster] quarry read failed (non-fatal):', err.message); }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { readEmployeeRoster };
