'use strict';
/**
 * The company's machines, as ONE definition.
 *
 * A piece of equipment can live in three places, because each job division
 * brought its own list with it:
 *
 *   - `equipment_list`                     canonical (turf)
 *   - `<company>:fct_paving_lists`         paving's blob
 *   - `<company>:fct_kiewit_lists`         kiewit's blob
 *
 * The table is turf's list and nothing else. Everything in it arrived through
 * sync-normalized.js, and syncForKey routes ONLY `fct_lists` to syncLists —
 * `fct_paving_lists` and `fct_kiewit_lists` are routed nowhere, so paving and
 * kiewit have never had a single machine in that table.
 *
 * Which is why "operated equipment: yes" on a paving day offered a turf list:
 * the Timesheet picker reads GET /api/equipment, that read the table, and the
 * table is turf. The operator picked the closest thing or left it blank, and
 * the cost row was coded per machine from a guess days later — the exact
 * failure the question was added to remove.
 *
 * So the union lives here and every picker reads it, the way api/lib/roster.js
 * already does for people. A machine is a machine once: matching is
 * case-insensitive, and the first source to claim it wins — which keeps the
 * table's id and sort_order ahead of a bare blob entry.
 *
 * Each row carries `divisions`: every list it was found in, not just the first.
 * A pickup kept by both turf and paving is ONE machine on two lists, and the
 * Timesheet narrows each job block's picker to the list belonging to that
 * block's division — so the division has to survive the dedup rather than be
 * decided by whichever source happened to be read first.
 *
 * `unit_cost` is the one field a later source may still fill in. A real price
 * beats a missing one and beats a zero, because a machine priced properly in
 * one list and at 0 in another is a gap in that list, not a machine that runs
 * for free. Same rule buildCostResolver in api/timesheet-entries.js follows.
 *
 * The blobs are read inside one try/catch: a division that has never written
 * its list must not take the whole picker down with it, and falling back to the
 * table alone is no worse than the behaviour this replaces.
 */

// The divisions whose equipment reaches nobody unless it is read from their
// blob. Deliberately NOT `fct_lists`: turf's list is what the table already
// holds, and reading turf's blob on top of it would undo any removal the table
// records — syncLists only ever upserts, so a machine dropped from the table
// would walk straight back in off the blob that fed it. Same bargain
// api/lib/roster.js strikes: canonical table for turf, blobs for the two
// divisions that were never synced into one.
const DIVISION_LIST_KEYS = [
  ['paving', 'fct_paving_lists'],
  ['kiewit', 'fct_kiewit_lists'],
];

const eqKey = s => String(s == null ? '' : s).trim().toLowerCase();

// Blob lists hold either bare strings or {name, unit_cost} objects.
function blobName(e) {
  return String((typeof e === 'string' ? e : (e && e.name)) || '').trim();
}
function blobCost(e) {
  const n = Number(e && typeof e === 'object' ? (e.unit_cost ?? e.unitCost) : NaN);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Every machine on the company's books, deduplicated by name.
 *
 * Rows carry the shape GET /api/equipment has always returned
 * ({ id, name, unit_cost, sort_order }) plus `divisions`; a blob-only machine
 * has no row in the table, so its `id` is null and `sort_order` continues past
 * the table's.
 */
async function readEquipmentRoster(sql, companyCode) {
  const byName = new Map(); // lowercased name → row

  const tableRows = await sql`
    SELECT id, name, unit_cost, sort_order
    FROM   equipment_list
    WHERE  company_code = ${companyCode} AND active = TRUE
    ORDER  BY sort_order ASC, name ASC
  `;
  for (const r of tableRows) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    // 'turf': the table is turf's list, whatever its company-wide name
    // suggests — syncLists is fed by `fct_lists` and by nothing else.
    byName.set(eqKey(name), {
      id:         r.id,
      name,
      unit_cost:  r.unit_cost,
      sort_order: r.sort_order,
      divisions:  ['turf'],
    });
  }

  // Appended after the table in a fixed division order rather than merged into
  // it: the table's sort_order is a hand-ordered list somebody arranged, and
  // interleaving new names through it would reorder a picker nobody asked to
  // have reordered. Every caller re-sorts alphabetically anyway.
  let next = tableRows.length;
  try {
    const keys = DIVISION_LIST_KEYS.map(([, k]) => `${companyCode}:${k}`);
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    const byKey = new Map(rows.map(r => [r.key, r.value]));

    for (const [division, key] of DIVISION_LIST_KEYS) {
      const blob = byKey.get(`${companyCode}:${key}`);
      const list = blob && Array.isArray(blob.equipment) ? blob.equipment : [];
      for (const e of list) {
        const name = blobName(e);
        if (!name) continue;
        const k    = eqKey(name);
        const cost = blobCost(e);
        const seen = byName.get(k);
        if (seen) {
          // Known already. Two things are still worth taking: a price the
          // winning source didn't have, and the fact that THIS division keeps
          // it too — without which a pickup on both lists would be offered to
          // one division's crew and hidden from the other's.
          if (cost > 0 && !(Number(seen.unit_cost) > 0)) seen.unit_cost = cost;
          if (!seen.divisions.includes(division)) seen.divisions.push(division);
          continue;
        }
        byName.set(k, {
          id:         null,
          name,
          unit_cost:  cost,
          sort_order: next++,
          divisions:  [division],
        });
      }
    }
  } catch (err) {
    console.error('[equipment] division list blobs read failed (non-fatal):', err.message);
  }

  return Array.from(byName.values());
}

module.exports = { readEquipmentRoster, DIVISION_LIST_KEYS };
