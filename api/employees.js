'use strict';
/**
 * GET    /api/employees                 — list all active employees for the company
 * PUT    /api/employees                 — full replace: sync entire employee array
 * POST   /api/employees                 — create a single employee
 * PATCH  /api/employees?id=N            — partial update of one employee (currently
 *                                         only `is_supervisor`; used by the global
 *                                         "Manage Supervisors" UI on divisions.html)
 * DELETE /api/employees?id=N            — hard-delete one employee by id
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    // Returns the union of every roster in the company — the canonical
    // `employees` table (turf/dust/trucking) + paving's separate
    // `fct_paving_lists.employees` blob + the `quarry_employees` table.
    // Deduplicated by name so the global "Manage Supervisors" modal shows
    // everyone exactly once. `is_supervisor` only comes from the employees
    // table — paving/quarry-only people start out unflagged and a PATCH
    // will create their row when first flipped on.
    if (req.method === 'GET') {
      const tableRows = await sql`
        SELECT id, name, job_class,
               pw_rate       AS prevailing_rate,
               non_pw_rate   AS non_prevailing_rate,
               is_supervisor,
               sort_order
        FROM   employees
        WHERE  company_code = ${companyCode} AND active = TRUE
        ORDER  BY sort_order ASC, name ASC
      `;

      const byName = new Map(); // lowercased name → row
      for (const r of tableRows) {
        byName.set(r.name.toLowerCase(), {
          id:                 r.id,
          name:               r.name,
          job_class:          r.job_class || null,
          prevailing_rate:    r.prevailing_rate,
          non_prevailing_rate:r.non_prevailing_rate,
          is_supervisor:      r.is_supervisor === true,
          source:             'employees',
        });
      }

      // Paving — blob lives at "<company>:fct_paving_lists"
      try {
        const pBlob = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_paving_lists'}`;
        const pList = pBlob.length && pBlob[0].value && Array.isArray(pBlob[0].value.employees)
          ? pBlob[0].value.employees
          : [];
        for (const e of pList) {
          const name = (typeof e === 'string' ? e : (e && e.name)) || '';
          const trimmed = name.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          (typeof e === 'object' && e.job_class) || null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            source:             'paving',
          });
        }
      } catch (err) {
        console.error('[employees GET] paving blob read failed (non-fatal):', err.message);
      }

      // Kiewit Pinetree — blob lives at "<company>:fct_kiewit_lists"
      try {
        const kBlob = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_kiewit_lists'}`;
        const kList = kBlob.length && kBlob[0].value && Array.isArray(kBlob[0].value.employees)
          ? kBlob[0].value.employees
          : [];
        for (const e of kList) {
          const name = (typeof e === 'string' ? e : (e && e.name)) || '';
          const trimmed = name.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          (typeof e === 'object' && e.job_class) || null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            source:             'kiewit',
          });
        }
      } catch (err) {
        console.error('[employees GET] kiewit blob read failed (non-fatal):', err.message);
      }

      // Quarry — quarry_employees table
      try {
        const qRows = await sql`
          SELECT name FROM quarry_employees
          WHERE company_code = ${companyCode}
        `;
        for (const r of qRows) {
          const trimmed = (r.name || '').trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, {
            id:                 null,
            name:               trimmed,
            job_class:          null,
            prevailing_rate:    null,
            non_prevailing_rate:null,
            is_supervisor:      false,
            source:             'quarry',
          });
        }
      } catch (err) {
        console.error('[employees GET] quarry read failed (non-fatal):', err.message);
      }

      const merged = Array.from(byName.values())
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ employees: merged });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { employees } = req.body || {};
      if (!Array.isArray(employees)) return res.status(400).json({ error: 'employees array required' });

      const incoming = employees
        .map((e, i) => ({ ...e, _i: i }))
        .filter(e => e.name?.trim());
      const incomingNames = new Set(incoming.map(e => e.name.trim()));

      // Bulk-wipe protection: an empty incoming list against a non-trivial
      // employees table is almost always a client bug (race / stale state)
      // and would silently destroy the company's payroll roster.
      // Single-employee deletes still work via DELETE /api/employees?id=.
      const existing = await sql`SELECT name FROM employees WHERE company_code = ${companyCode}`;
      if (incoming.length === 0 && existing.length > 1 && req.query.force !== '1') {
        console.warn(`[employees] refused empty PUT: ${existing.length} employees would have been wiped for ${companyCode}`);
        return res.status(409).json({
          error: 'Refusing to wipe employees',
          detail: `Cannot replace ${existing.length} employees with an empty list. Use DELETE /api/employees?id= for single removals, or pass ?force=1 to override.`,
        });
      }

      // Remove deleted employees
      for (const { name } of existing) {
        if (!incomingNames.has(name)) {
          await sql`DELETE FROM employees WHERE company_code = ${companyCode} AND name = ${name}`;
        }
      }

      // Upsert each employee
      for (const e of incoming) {
        const pwRate    = parseFloat(e.prevailing_rate    ?? e.pw_rate)    || null;
        const nonPwRate = parseFloat(e.non_prevailing_rate ?? e.non_pw_rate) || null;
        const isSup     = Boolean(e.is_supervisor);
        await sql`
          INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, is_supervisor, sort_order, active, updated_at)
          VALUES (
            ${companyCode}, ${e.name.trim()}, ${e.job_class || null},
            ${pwRate}, ${nonPwRate}, ${isSup}, ${e._i}, TRUE, NOW()
          )
          ON CONFLICT (company_code, name) DO UPDATE SET
            job_class     = EXCLUDED.job_class,
            pw_rate       = EXCLUDED.pw_rate,
            non_pw_rate   = EXCLUDED.non_pw_rate,
            is_supervisor = EXCLUDED.is_supervisor,
            sort_order    = EXCLUDED.sort_order,
            active        = TRUE,
            updated_at    = NOW()
        `;
      }
      return res.json({ ok: true });
    }

    // ── POST (single create) ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, job_class, prevailing_rate, non_prevailing_rate, is_supervisor } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });

      const [row] = await sql`
        INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, is_supervisor, sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name.trim()}, ${job_class || null},
          ${parseFloat(prevailing_rate) || null},
          ${parseFloat(non_prevailing_rate) || null},
          ${Boolean(is_supervisor)},
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM employees WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          job_class     = EXCLUDED.job_class,
          pw_rate       = EXCLUDED.pw_rate,
          non_pw_rate   = EXCLUDED.non_pw_rate,
          is_supervisor = EXCLUDED.is_supervisor,
          active        = TRUE,
          updated_at    = NOW()
        RETURNING id, name, job_class,
                  pw_rate AS prevailing_rate, non_pw_rate AS non_prevailing_rate,
                  is_supervisor,
                  sort_order
      `;
      return res.status(201).json({ employee: row });
    }

    // ── PATCH (toggle is_supervisor by name) ──────────────────────────────
    // Upserts the employees row by (company_code, name) so people who only
    // exist in paving's `fct_paving_lists` or in `quarry_employees` can be
    // flagged as supervisors without first existing in the canonical table.
    // Only company admins or platform admins may flip the flag.
    if (req.method === 'PATCH') {
      if (payload.role !== 'admin' && !payload.isPlatformAdmin) {
        return res.status(403).json({ error: 'Company admin access required' });
      }
      const name = (req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });

      const fields = req.body || {};
      if (typeof fields.is_supervisor === 'undefined') {
        return res.status(400).json({ error: 'is_supervisor field required' });
      }
      const isSup = Boolean(fields.is_supervisor);

      const [row] = await sql`
        INSERT INTO employees (company_code, name, is_supervisor, sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name}, ${isSup},
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM employees WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          is_supervisor = EXCLUDED.is_supervisor,
          updated_at    = NOW()
        RETURNING id, name, is_supervisor
      `;
      return res.json({ ok: true, employee: row });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM employees WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[employees]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
