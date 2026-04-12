'use strict';
/**
 * GET    /api/employees         — list all active employees for the company
 * PUT    /api/employees         — full replace: sync entire employee array
 * POST   /api/employees         — create a single employee
 * DELETE /api/employees?id=N    — hard-delete one employee by id
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
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, job_class,
               pw_rate      AS prevailing_rate,
               non_pw_rate  AS non_prevailing_rate,
               sort_order
        FROM   employees
        WHERE  company_code = ${companyCode} AND active = TRUE
        ORDER  BY sort_order ASC, name ASC
      `;
      return res.json({ employees: rows });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { employees } = req.body || {};
      if (!Array.isArray(employees)) return res.status(400).json({ error: 'employees array required' });

      const incoming = employees
        .map((e, i) => ({ ...e, _i: i }))
        .filter(e => e.name?.trim());
      const incomingNames = new Set(incoming.map(e => e.name.trim()));

      // Remove deleted employees
      const existing = await sql`SELECT name FROM employees WHERE company_code = ${companyCode}`;
      for (const { name } of existing) {
        if (!incomingNames.has(name)) {
          await sql`DELETE FROM employees WHERE company_code = ${companyCode} AND name = ${name}`;
        }
      }

      // Upsert each employee
      for (const e of incoming) {
        const pwRate    = parseFloat(e.prevailing_rate    ?? e.pw_rate)    || null;
        const nonPwRate = parseFloat(e.non_prevailing_rate ?? e.non_pw_rate) || null;
        await sql`
          INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, sort_order, active, updated_at)
          VALUES (
            ${companyCode}, ${e.name.trim()}, ${e.job_class || null},
            ${pwRate}, ${nonPwRate}, ${e._i}, TRUE, NOW()
          )
          ON CONFLICT (company_code, name) DO UPDATE SET
            job_class   = EXCLUDED.job_class,
            pw_rate     = EXCLUDED.pw_rate,
            non_pw_rate = EXCLUDED.non_pw_rate,
            sort_order  = EXCLUDED.sort_order,
            active      = TRUE,
            updated_at  = NOW()
        `;
      }
      return res.json({ ok: true });
    }

    // ── POST (single create) ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, job_class, prevailing_rate, non_prevailing_rate } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });

      const [row] = await sql`
        INSERT INTO employees (company_code, name, job_class, pw_rate, non_pw_rate, sort_order, active, updated_at)
        VALUES (
          ${companyCode}, ${name.trim()}, ${job_class || null},
          ${parseFloat(prevailing_rate) || null},
          ${parseFloat(non_prevailing_rate) || null},
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM employees WHERE company_code = ${companyCode}),
          TRUE, NOW()
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          job_class   = EXCLUDED.job_class,
          pw_rate     = EXCLUDED.pw_rate,
          non_pw_rate = EXCLUDED.non_pw_rate,
          active      = TRUE,
          updated_at  = NOW()
        RETURNING id, name, job_class,
                  pw_rate AS prevailing_rate, non_pw_rate AS non_prevailing_rate,
                  sort_order
      `;
      return res.status(201).json({ employee: row });
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
