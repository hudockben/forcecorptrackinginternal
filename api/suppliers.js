'use strict';
/**
 * GET  /api/suppliers          — list all active suppliers for the company
 * PUT  /api/suppliers          — full replace: sync entire supplier array
 * POST /api/suppliers          — create a single supplier
 * DELETE /api/suppliers?id=N   — hard-delete one supplier by id
 */
const { neon }       = require('@neondatabase/serverless');
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
        SELECT id, name, contact_name, phone, email, state, address, website, sort_order
        FROM   suppliers
        WHERE  company_code = ${companyCode} AND active = TRUE
        ORDER  BY sort_order ASC, name ASC
      `;
      return res.json({ suppliers: rows });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { suppliers } = req.body || {};
      if (!Array.isArray(suppliers)) return res.status(400).json({ error: 'suppliers array required' });

      // Build set of incoming names so we can remove deleted ones
      const incoming = suppliers
        .map((s, i) => ({ ...s, _i: i }))
        .filter(s => s.name?.trim());
      const incomingNames = new Set(incoming.map(s => s.name.trim()));

      // Delete rows that were removed from the list
      const existing = await sql`SELECT name FROM suppliers WHERE company_code = ${companyCode}`;
      for (const { name } of existing) {
        if (!incomingNames.has(name)) {
          await sql`DELETE FROM suppliers WHERE company_code = ${companyCode} AND name = ${name}`;
        }
      }

      // Upsert each incoming supplier (preserves id, updates fields)
      for (const s of incoming) {
        await sql`
          INSERT INTO suppliers (company_code, name, contact_name, phone, email, state, address, website, sort_order, active)
          VALUES (
            ${companyCode}, ${s.name.trim()},
            ${s.contact_name || null}, ${s.phone || null}, ${s.email || null},
            ${s.state || null}, ${s.address || null}, ${s.website || null},
            ${s._i}, TRUE
          )
          ON CONFLICT (company_code, name) DO UPDATE SET
            contact_name = EXCLUDED.contact_name,
            phone        = EXCLUDED.phone,
            email        = EXCLUDED.email,
            state        = EXCLUDED.state,
            address      = EXCLUDED.address,
            website      = EXCLUDED.website,
            sort_order   = EXCLUDED.sort_order,
            active       = TRUE
        `;
      }
      return res.json({ ok: true });
    }

    // ── POST (single create) ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, contact_name, phone, email, state, address, website } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });

      const [row] = await sql`
        INSERT INTO suppliers (company_code, name, contact_name, phone, email, state, address, website, sort_order, active)
        VALUES (
          ${companyCode}, ${name.trim()},
          ${contact_name || null}, ${phone || null}, ${email || null},
          ${state || null}, ${address || null}, ${website || null},
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM suppliers WHERE company_code = ${companyCode}),
          TRUE
        )
        ON CONFLICT (company_code, name) DO UPDATE SET
          contact_name = EXCLUDED.contact_name, phone    = EXCLUDED.phone,
          email        = EXCLUDED.email,        state    = EXCLUDED.state,
          address      = EXCLUDED.address,      website  = EXCLUDED.website,
          active       = TRUE
        RETURNING id, name, contact_name, phone, email, state, address, website, sort_order
      `;
      return res.status(201).json({ supplier: row });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM suppliers WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[suppliers]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
