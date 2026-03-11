'use strict';
// Usage: DATABASE_URL=<your-neon-url> node promote-admin.js
const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL env var'); process.exit(1); }

(async () => {
  const sql = neon(DATABASE_URL);
  const result = await sql`
    UPDATE users SET role = 'admin'
    WHERE username = 'hudockben' AND company_code = 'FORCECORP'
    RETURNING username, company_code, role
  `;
  if (!result.length) {
    console.error('User not found — check username and company_code');
    process.exit(1);
  }
  console.log('Updated:', result[0]);
})();
