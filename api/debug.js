'use strict';

const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const checks = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    JWT_SECRET: !!process.env.JWT_SECRET,
    ADMIN_SECRET: !!process.env.ADMIN_SECRET,
  };

  let dbCheck = null;
  let companies = [];
  let users = [];

  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      companies = await sql`SELECT code, name FROM companies`;
      users = await sql`SELECT username, company_code, role FROM users`;
      dbCheck = 'ok';
    } catch (err) {
      dbCheck = err.message;
    }
  }

  return res.json({ checks, dbCheck, companies, users });
};
