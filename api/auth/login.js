'use strict';

const { neon }   = require('@neondatabase/serverless');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyCode, username, password } = req.body || {};

  if (!companyCode || !username || !password) {
    return res.status(400).json({ error: 'companyCode, username, and password are required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Look up user within that company
    const rows = await sql`
      SELECT u.id, u.username, u.password_hash, u.role, c.name AS company_name
      FROM users u
      JOIN companies c ON c.code = u.company_code
      WHERE LOWER(u.username) = LOWER(${username.trim()})
        AND LOWER(u.company_code) = LOWER(${companyCode.trim()})
    `;

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid company code, username, or password' });
    }

    const token = jwt.sign(
      {
        userId:      user.id,
        username:    user.username,
        companyCode: companyCode.trim().toUpperCase(),
        companyName: user.company_name,
        role:        user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({
      ok: true,
      token,
      user: {
        username:    user.username,
        companyCode: companyCode.trim().toUpperCase(),
        companyName: user.company_name,
        role:        user.role,
      },
    });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
