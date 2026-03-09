'use strict';

const { neon } = require('@neondatabase/serverless');

const ALLOWED_KEYS = ['fct_projects', 'fct_lists', 'fct_cost_rows'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.query.key;

  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ error: `Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}` });
  }

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${key}`;
    return res.json({ value: rows.length ? rows[0].value : null });
  }

  if (req.method === 'PUT') {
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: '`value` field is required in request body' });
    }
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
