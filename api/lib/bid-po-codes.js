'use strict';
/**
 * A bid line's codes renamed on the bid page, carried to the job's purchase
 * orders.
 *
 * An order keeps its own copy of the cost and sub code it was raised under
 * (the Purchase Orders tab copies them off the bid line picked). Procurement
 * matches a row to an order nobody linked it to by the row's LIVE bid codes
 * against that copy (procurement.js effectivePO). So a section or a sub code
 * renamed on the bid left every such order behind: the row read Not Ordered
 * with a red Late flag, its PO # and Date Ordered went blank, and "Create PO
 * from selected" raised a second order for the material without asking.
 * A supplier renamed on Admin > Suppliers already reaches the orders on the
 * server (api/supplier-contacts.js renamePOs); this does the same for codes.
 *
 * Two saves rename a line, and each hands in the bid as stored just before it
 * and as it stores it: the whole-job save (api/data/[key].js; a section
 * renamed saves the whole job before its lines) and the per-line save
 * (api/bid-items.js; a sub code renamed goes through it alone). The old codes
 * come off the stored bid, never off the Procurement rows' copy of them: an
 * open Procurement sheet brings that copy up to date on its own (its code
 * sync), sometimes before the per-line save lands, and the old codes would be
 * gone by then.
 */

const procDocs = require('./procurement-docs');
const poSync   = require('./po-sync');

const text = v => (v == null ? '' : String(v));
// Codes compared the way the Procurement sheet compares them: case, spacing,
// dashes and quotes do not make two codes different (procDocs.codeKey).
const pairKey = (cost, sub) => procDocs.codeKey(cost) + '\u0000' + procDocs.codeKey(sub);

const ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * The division and job a blob key holds the bid of ({ division, projectId }),
 * or null for any other key. The keys are the ones the pages and
 * api/bid-items.js write (procDocs.PROJECT_KEY_PREFIX).
 */
function projectBlobOf(key) {
  const k = text(key);
  for (const [division, prefix] of Object.entries(procDocs.PROJECT_KEY_PREFIX)) {
    if (!k.startsWith(prefix)) continue;
    const projectId = k.slice(prefix.length);
    return ID_RE.test(projectId) ? { division, projectId } : null;
  }
  return null;
}

/**
 * The code renames between two copies of one job's bid, line by line (by
 * id): [{ from, cost_code, sub_code }], `from` being the old pair's key and
 * cost_code / sub_code the new pair as the line holds it. `before` may hold
 * just the lines that were written; `after` is the whole bid as stored.
 *
 * Not a rename:
 *   - a code blanked (a rename half typed): the order waits for the name;
 *   - a line that had no codes at all — "+ New PO" saves an order with none,
 *     and it is no line's;
 *   - old codes another line of the bid still has: the order may well be for
 *     that line, and it still matches it;
 *   - old codes whose lines went two different ways: there is no telling
 *     which way the order should go.
 */
function bidCodeRenames(before, after) {
  const k = procDocs.codeKey;
  const lines = v => (Array.isArray(v) ? v : []).filter(l => l && typeof l === 'object' && l.id != null);
  const was = new Map(lines(before).map(l => [String(l.id), l]));
  const now = lines(after);
  const carried = new Set(now.map(l => pairKey(l.cost_code, l.sub_code)));
  const to = new Map();
  for (const l of now) {
    const old = was.get(String(l.id));
    if (!old) continue;
    const from = pairKey(old.cost_code, old.sub_code);
    const into = pairKey(l.cost_code, l.sub_code);
    if (from === into || carried.has(from)) continue;
    if (!k(old.cost_code) && !k(old.sub_code)) continue;
    if ((k(old.cost_code) && !k(l.cost_code)) || (k(old.sub_code) && !k(l.sub_code))) continue;
    if (to.has(from)) {
      const seen = to.get(from);
      if (seen && seen.into !== into) to.set(from, null);
      continue;
    }
    to.set(from, { into, cost_code: text(l.cost_code), sub_code: text(l.sub_code) });
  }
  return [...to].filter(([, p]) => p).map(([from, p]) => ({ from, cost_code: p.cost_code, sub_code: p.sub_code }));
}

/**
 * Give the job's purchase orders that carry a renamed line's old codes its
 * new ones: this company's orders in this division's list, on this job,
 * linked to a Procurement row or not (the Purchase Orders tab shows the codes
 * either way). Only the two codes change.
 *
 * Done on the stored list as it is at the instant of the write, a
 * compare-and-set that starts again from a fresh read whenever someone saved
 * in between (api/lib/po-sync.js), so nobody's change to an order is undone.
 * Then the normalized mirror, best effort, as the supplier rename does. The
 * job's cost rows keep their codes: a bid rename re-codes none of them.
 *
 * Returns { pos, ids }, with error 'busy' when the list kept changing under
 * every try.
 */
async function renamePOCodes(sql, { companyCode, division, projectId, renames }) {
  if (!Array.isArray(renames) || !renames.length || !projectId) return { pos: 0, ids: [] };
  const byFrom = new Map(renames.map(r => [r.from, r]));
  const job = text(projectId);
  let hit = [];
  const saved = await poSync.mutatePOBlob(sql, poSync.blobKeyFor(companyCode, division), list => {
    hit = [];
    const next = list.map(po => {
      if (!po || typeof po !== 'object' || text(po.project_id) !== job) return po;
      const r = byFrom.get(pairKey(po.cost_code, po.sub_code));
      if (!r) return po;
      const renamed = { ...po, cost_code: r.cost_code, sub_code: r.sub_code };
      hit.push(renamed);
      return renamed;
    });
    return hit.length ? next : null;
  });
  if (!saved.ok) return { pos: 0, ids: [], error: 'busy' };
  if (!saved.changed || !hit.length) return { pos: 0, ids: [] };
  const ids = hit.map(po => text(po.id));
  try {
    await sql`
      UPDATE purchase_orders p
         SET cost_code = NULLIF(t.cost_code, ''), sub_code = NULLIF(t.sub_code, ''), updated_at = NOW()
        FROM unnest(${ids}::text[], ${hit.map(po => text(po.cost_code))}::text[], ${hit.map(po => text(po.sub_code))}::text[])
             AS t(id, cost_code, sub_code)
       WHERE p.company_code = ${companyCode} AND p.division = ${division} AND p.id = t.id`;
  } catch (err) {
    console.warn(`[bid-po-codes] purchase-order mirror not updated for company=${companyCode} job=${job}: ${err.message}`);
  }
  return { pos: hit.length, ids };
}

/**
 * The two together: what a save of the bid renamed, carried to the job's
 * orders. A save that renamed nothing reads nothing.
 */
async function carryBidCodeRenames(sql, { companyCode, division, projectId, before, after }) {
  const renames = bidCodeRenames(before, after);
  if (!renames.length) return { pos: 0, ids: [] };
  const out = await renamePOCodes(sql, { companyCode, division, projectId, renames });
  if (out.error) {
    console.warn(`[bid-po-codes] purchase orders of company=${companyCode} job=${projectId} not renamed: the list kept changing`);
  }
  return out;
}

module.exports = { projectBlobOf, bidCodeRenames, renamePOCodes, carryBidCodeRenames };
