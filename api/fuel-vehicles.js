'use strict';
/**
 * Fuel vehicles — the truck roster behind Fuel Admin's Vehicles tab.
 *
 *   GET    /api/fuel-vehicles              — list, by truck number
 *     ?include_inactive=1 to include retired trucks (default: active only)
 *
 *   POST   /api/fuel-vehicles              — create, or update by id
 *     Body: { id?, truck_number, vin, model_year, make, ifta, ifta_sticker,
 *             active, notes }
 *     Without an id this creates. A create whose truck_number already exists
 *     UPDATES that row rather than failing — see below.
 *
 *   DELETE /api/fuel-vehicles?id=N         — remove one vehicle
 *
 * Access: Fuel Admin (or platform admin) throughout. The field form doesn't
 * read this — a driver types the truck number they are standing next to, and
 * matching it to a vehicle is the office's job at report time.
 *
 * truck_number is the join to fuel_submissions and is unique per company. A
 * create that collides with an existing truck number is treated as an edit of
 * that truck: the office thinks in truck numbers, and "that number is taken"
 * is not useful when the thing they are looking at IS that truck. What it must
 * never do is insert a second row — every gallon that truck burned would then
 * be counted twice in the by-vehicle totals.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function safeStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function safeBool(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

// A VIN is stamped in upper case and never contains spaces, so the office can
// paste one out of a title or a spreadsheet without the roster ending up with
// two spellings of the same vehicle. Length is capped rather than pinned at
// 17: pre-1981 trucks and trailers carry shorter ones, and refusing those
// would keep a real vehicle off the roster over a formatting rule.
function normalizeVin(v) {
  const s = safeStr(v, 32);
  return s ? s.toUpperCase().replace(/\s+/g, '') : null;
}

function dbToVehicle(r) {
  if (!r) return null;
  return {
    id:           String(r.id),
    truck_number: r.truck_number == null ? null : Number(r.truck_number),
    vin:          r.vin || null,
    model_year:   r.model_year == null ? null : Number(r.model_year),
    make:         r.make || null,
    ifta:         r.ifta === true,
    ifta_sticker: r.ifta_sticker || null,
    active:       r.active !== false,
    notes:        r.notes || null,
    created_at:   r.created_at || null,
    updated_at:   r.updated_at || null,
  };
}

/**
 * Validate and shape an incoming vehicle. Returns { data } or { error }.
 *
 * truck_number is the only hard requirement — it is the join to the fuel
 * entries, and a row without one cannot be matched to a gallon of anything.
 * The rest may be filled in later: a truck is often added the day it arrives
 * and titled a week after.
 */
function normalizeVehicle(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const truck_number = safeInt(b.truck_number);
  if (truck_number == null)  return { error: 'A truck number is required.' };
  if (truck_number < 0)      return { error: 'Truck number cannot be negative.' };
  if (truck_number > 2147483647) return { error: 'Truck number is too large.' };

  const model_year = safeInt(b.model_year);
  // A wide window on purpose. It exists to catch a mistyped mileage figure
  // landing in the year box, not to have an opinion about how old a truck in
  // the yard is allowed to be.
  if (model_year != null && (model_year < 1900 || model_year > 2100)) {
    return { error: 'Year should be a four-digit year.' };
  }

  const ifta = safeBool(b.ifta) === true;
  const ifta_sticker = safeStr(b.ifta_sticker, 60);

  return {
    data: {
      truck_number,
      vin:          normalizeVin(b.vin),
      model_year,
      make:         safeStr(b.make, 80),
      ifta,
      // A sticker number on a vehicle that isn't IFTA-qualified is a leftover
      // from before the box was unticked, and it would show up in the report's
      // exception list forever. Cleared with the flag it belongs to.
      ifta_sticker: ifta ? ifta_sticker : null,
      active:       safeBool(b.active) !== false,
      notes:        safeStr(b.notes, 500),
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const canAdmin = hasDivisionAccess(payload, 'fuel_admin') || payload.isPlatformAdmin;
  if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access required' });

  const sql = neon(process.env.DATABASE_URL);
  const { companyCode } = payload;
  const q = req.query || {};

  try {
    if (req.method === 'GET') {
      const all = q.include_inactive === '1' || q.include_inactive === 'true';
      const rows = await sql`
        SELECT * FROM fuel_vehicles
        WHERE company_code = ${companyCode}
          AND (${all}::boolean OR active = TRUE)
        ORDER BY truck_number ASC
      `;
      return res.json({ vehicles: rows.map(dbToVehicle) });
    }

    if (req.method === 'POST') {
      const { data, error } = normalizeVehicle(req.body || {});
      if (error) return res.status(400).json({ error });

      const id = safeInt((req.body && req.body.id) || q.id);

      if (id) {
        // Editing a known row. The truck number may be changing, so the
        // unique index is still what stops it colliding with another row —
        // caught below rather than raced against a pre-check.
        const [existing] = await sql`
          SELECT id FROM fuel_vehicles WHERE id = ${id} AND company_code = ${companyCode}
        `;
        if (!existing) return res.status(404).json({ error: 'Vehicle not found' });

        const [clash] = await sql`
          SELECT id FROM fuel_vehicles
          WHERE company_code = ${companyCode} AND truck_number = ${data.truck_number} AND id <> ${id}
          LIMIT 1
        `;
        if (clash) {
          return res.status(409).json({
            error: `Truck ${data.truck_number} is already on the list. Edit that row instead of moving this one onto its number.`,
          });
        }

        const [updated] = await sql`
          UPDATE fuel_vehicles SET
            truck_number = ${data.truck_number},
            vin          = ${data.vin},
            model_year   = ${data.model_year},
            make         = ${data.make},
            ifta         = ${data.ifta},
            ifta_sticker = ${data.ifta_sticker},
            active       = ${data.active},
            notes        = ${data.notes},
            updated_at   = NOW()
          WHERE id = ${id} AND company_code = ${companyCode}
          RETURNING *
        `;
        return res.json({ ok: true, vehicle: dbToVehicle(updated) });
      }

      // No id: create, or fold into the row that already holds this truck
      // number. ON CONFLICT rather than a SELECT-then-INSERT so two admins
      // adding the same truck at once still end up with one row.
      const [saved] = await sql`
        INSERT INTO fuel_vehicles
          (company_code, truck_number, vin, model_year, make, ifta, ifta_sticker, active, notes)
        VALUES
          (${companyCode}, ${data.truck_number}, ${data.vin}, ${data.model_year}, ${data.make},
           ${data.ifta}, ${data.ifta_sticker}, ${data.active}, ${data.notes})
        ON CONFLICT (company_code, truck_number) DO UPDATE SET
          vin          = EXCLUDED.vin,
          model_year   = EXCLUDED.model_year,
          make         = EXCLUDED.make,
          ifta         = EXCLUDED.ifta,
          ifta_sticker = EXCLUDED.ifta_sticker,
          active       = EXCLUDED.active,
          notes        = EXCLUDED.notes,
          updated_at   = NOW()
        RETURNING *
      `;
      return res.json({ ok: true, vehicle: dbToVehicle(saved) });
    }

    if (req.method === 'DELETE') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const [existing] = await sql`
        SELECT * FROM fuel_vehicles WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Vehicle not found' });
      await sql`DELETE FROM fuel_vehicles WHERE id = ${id} AND company_code = ${companyCode}`;
      // Fuel entries are untouched on purpose: they record what a driver
      // reported, and deleting a truck from the roster must not quietly
      // rewrite the history of the fuel bought for it. Those entries surface
      // in the report's exception list as unmatched until the truck is put
      // back or the report is run over a range that predates it.
      return res.json({ ok: true, vehicle: dbToVehicle(existing) });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fuel-vehicles]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

module.exports._test = { normalizeVehicle, normalizeVin, dbToVehicle };
