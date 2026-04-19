'use strict';

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');

/**
 * GET /api/debug
 * Health check — confirms env vars are set and DB is reachable.
 * Requires a valid JWT (any role). Never returns company or user data.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require valid JWT — no unauthenticated access
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const checks = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    JWT_SECRET:   !!process.env.JWT_SECRET,
    ADMIN_SECRET: !!process.env.ADMIN_SECRET,
  };

  let dbCheck = null;
  let appDataKeys = null;
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`SELECT 1`;
      dbCheck = 'ok';
      // Show app_data keys that relate to trucking (for diagnostics)
      const rows = await sql`
        SELECT key,
               CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) ELSE NULL END AS arr_len,
               jsonb_typeof(value) AS val_type,
               updated_at
        FROM app_data
        WHERE key LIKE '%truck_division%' OR key LIKE '%fct_lists%'
        ORDER BY key
      `;
      appDataKeys = rows.map(r => ({
        key: r.key,
        arrLen: r.arr_len,
        valType: r.val_type,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      dbCheck = err.message;
    }
  }

  return res.json({ checks, dbCheck, appDataKeys });
};
