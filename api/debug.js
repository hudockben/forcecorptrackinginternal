'use strict';

const { neon } = require('@neondatabase/serverless');
const { authenticate } = require('./lib/auth');

/** The trucking blobs and their normalized counts: what this endpoint was built
 *  to show, and only ever shown to a verified account. */
async function blobListing(sql) {
  // Show app_data blob state for trucking keys
  const rows = await sql`
    SELECT key,
           CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) ELSE NULL END AS arr_len,
           jsonb_typeof(value) AS val_type,
           updated_at
    FROM app_data
    WHERE key LIKE '%truck_division%' OR key LIKE '%fct_lists%'
       OR key LIKE '%dust_settings%' OR key LIKE '%dust_lists%'
    ORDER BY key
  `;
  const appDataKeys = rows.map(r => ({
    key: r.key,
    arrLen: r.arr_len,
    valType: r.val_type,
    updatedAt: r.updated_at,
  }));

  // Show normalized table row counts for trucking
  try {
    const [normEntries, normUnits, normDrivers, normCustomers] = await Promise.all([
      sql`SELECT COUNT(*) AS n FROM truck_division_entries`,
      sql`SELECT COUNT(*) AS n FROM truck_division_units`,
      sql`SELECT COUNT(*) AS n FROM dropdown_lists WHERE list_name = 'truck_drivers'`,
      sql`SELECT COUNT(*) AS n FROM dropdown_lists WHERE list_name = 'truck_customers'`,
    ]);
    appDataKeys.push({
      _normalizedCounts: {
        truck_division_entries: Number(normEntries[0].n),
        truck_division_units:   Number(normUnits[0].n),
        truck_drivers:          Number(normDrivers[0].n),
        truck_customers:        Number(normCustomers[0].n),
      }
    });
  } catch (e) {
    appDataKeys.push({ _normalizedCountsError: e.message });
  }
  return appDataKeys;
}

/**
 * GET /api/debug
 * Health check — confirms env vars are set and DB is reachable.
 * Requires a valid JWT (any role). Never returns company or user data.
 *
 * The account behind the token is read first, as everywhere else, and a
 * missing or deleted one is refused. When that read FAILS, though, the token
 * was still genuine — authenticate only reaches the read after verifying it —
 * and an unreachable database is the very thing this endpoint exists to
 * report. So it answers anyway, with the environment and the database check
 * but not the blob listing, which waits for a verified account. `account`
 * says which: a database that answers SELECT 1 while the account read fails
 * points at the users or companies table rather than the connection.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require a valid JWT — no unauthenticated access
  const auth = await authenticate(req);
  if (!auth.payload && auth.status !== 503) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const accountVerified = Boolean(auth.payload);

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
      if (accountVerified) appDataKeys = await blobListing(sql);
    } catch (err) {
      dbCheck = err.message;
    }
  }

  return res.json({
    checks, dbCheck, appDataKeys,
    account: accountVerified ? 'ok' : 'could not be read',
  });
};
