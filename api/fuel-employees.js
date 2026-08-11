'use strict';
/**
 * Employee picker for the Fuel Submissions form.
 *
 *   GET /api/fuel-employees
 *     → { employees: [{ id, username }, ...] }   alphabetical
 *
 * The list is the company's USER ACCOUNTS, not the employees roster: the form
 * asks "which employee fueled", and the office identifies people on a fuel
 * entry by the username they sign in with. Sorted in the database rather than
 * in the page so both the field form and the Fuel Admin filter get the same
 * order without either having to remember to sort.
 *
 * Read-only, and readable by either side of the fuel workflow — the field form
 * fills its picker from it, and Fuel Admin fills its employee filter from the
 * same list so a name can never appear in one and not the other.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const allowed =
    hasDivisionAccess(payload, 'fuel')       ||
    hasDivisionAccess(payload, 'fuel_admin') ||
    payload.isPlatformAdmin;
  if (!allowed) {
    return res.status(403).json({ error: 'Fuel Submissions or Fuel Admin access required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // LOWER() in the sort key so "andy" and "Andy" can't land at opposite ends
    // of the list — usernames are created by hand and their casing wanders.
    const rows = await sql`
      SELECT id, username
      FROM   users
      WHERE  company_code = ${payload.companyCode}
      ORDER  BY LOWER(username) ASC
    `;
    return res.json({ employees: rows.map(r => ({ id: r.id, username: r.username })) });
  } catch (err) {
    console.error('[fuel-employees]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
