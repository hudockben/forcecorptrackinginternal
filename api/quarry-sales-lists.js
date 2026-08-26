'use strict';
/**
 * The pickers on the Quarry Sales form.
 *
 *   GET /api/quarry-sales-lists
 *     → { locations: [{id,name}], employees: [...], customers: [...],
 *         products: [...], payments: ['Cash','Credit'] }
 *
 * Read straight off the quarry's own Manage Lists blob (fct_quarry_lists) —
 * the same object the Sales Tracking comboboxes read — rather than the
 * quarry_* mirror tables. The blob is the source of truth and the mirrors only
 * catch up when it is next written, so reading the mirror is how a pit added
 * this morning ends up missing from the form this afternoon. It also means a
 * name can never be spelled one way in the form and another in the grid, which
 * is the whole reason these are pickers and not text boxes.
 *
 * Readable from either side of the workflow: the field form fills its pickers
 * from it, and a quarry user may read it too, so the office can see exactly
 * what the field was offered.
 *
 * Anything the list has no name for is dropped rather than returned blank — a
 * nameless option is one a worker can pick and then be refused for picking.
 *
 * Ids and names ONLY. Manage Lists also carries an hourly rate on every
 * employee and a sales-tax rate on every customer, and this is the one place a
 * user who holds quarry_sales and nothing else can see into the quarry's data
 * at all — so the shape is narrowed here rather than filtered in the page. The
 * form has no use for either figure: the office prices the load.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { PAYMENT_OPTIONS } = require('./lib/quarry-sales-options');

// Manage Lists bucket → the name the form asks for it by. 'employees' is
// plural in the blob and singular nowhere else; the rest match.
const BUCKETS = [
  ['location',  'locations'],
  ['employees', 'employees'],
  ['customer',  'customers'],
  ['product',   'products'],
];

// One bucket, as {id, name} pairs, sorted the way a human scans a phone list.
// Sorted here rather than in the page so the form and anything else reading
// this endpoint can never disagree about the order.
function optionsFrom(value, key) {
  const list = (value && typeof value === 'object' && Array.isArray(value[key])) ? value[key] : [];
  return list
    .filter(it => it && it.id && String(it.name || '').trim())
    .map(it => ({ id: String(it.id), name: String(it.name).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const allowed =
    hasDivisionAccess(payload, 'quarry_sales') ||
    hasDivisionAccess(payload, 'quarry')       ||
    payload.isPlatformAdmin;
  if (!allowed) {
    return res.status(403).json({ error: 'Quarry Sales or Quarry access required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const scoped = `${payload.companyCode}:fct_quarry_lists`;
    const rows = await sql`SELECT value FROM app_data WHERE key = ${scoped}`;
    const value = rows.length ? rows[0].value : null;

    const out = { payments: PAYMENT_OPTIONS.slice() };
    for (const [bucket, name] of BUCKETS) out[name] = optionsFrom(value, bucket);
    return res.json(out);
  } catch (err) {
    console.error('[quarry-sales-lists]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
