'use strict';
/**
 * Purchase-order delivery-line attachments.
 *
 * A file attached to one delivery line of an order is ONE project_documents
 * row with several document_links:
 *   - a 'folder' link to the folder the person picked (the order's own PO
 *     subfolder, normally),
 *   - a 'po' link to the order — so the order's paperclip lists and counts it,
 *     ensurePoFolder files it in the order's subfolder, and central purchasing
 *     (whose download is bound to a 'po' link) can open it,
 *   - a 'po_line' link whose target_id is "<poId>:<lineId>", and
 *   - a 'folder' link to the cost-code folder of the line's code (else the
 *     order's), when the order is on a job, so delivery tickets and invoices
 *     compile there next to the Procurement paperwork of that section.
 *
 * Why the target is the PAIR and not the line id alone: a raised line's id is
 * minted by the page and is unique only within its order in principle, and a
 * Daily Tracking line ('dr-<rowId>') keeps its id when its row's PO # changes
 * and the delivery moves to another order. Keyed by the pair, a line link can
 * never leak into another order, and counting needs no join to the PO blob.
 * Files stay with the order they were attached under: a 'dr-' delivery that
 * later moves keeps its files on the old order (on its paperclip and in its
 * folders), and the line on the new order starts at 0.
 *
 * Deleting a line or an order touches no document. The links persist, so a
 * line that comes back (the deleted-line resurrection paths) finds its files,
 * and nothing is ever lost: each file is on the order's paperclip and in its
 * folders regardless. v1 does not re-file when an order's or a line's cost
 * code changes later.
 *
 * Pure helpers only; the endpoint (api/documents.js) does the SQL.
 */

// Each part of the target. Covers the page's uid() (base36), UUIDs, and the
// server's 'dr-<rowId>' ids (row ids are up to 64 characters, so 'dr-' plus
// one is 67). Excludes ':' so the pair always splits back the same way.
const PO_LINE_PART_RE = /^[A-Za-z0-9_.-]{1,128}$/;

const isPoLinePart = v => typeof v === 'string' && PO_LINE_PART_RE.test(v);

/** The 'po_line' target for one line of one order, or null when either part is malformed. */
function poLineTarget(poId, lineId) {
  const p = poId == null ? '' : String(poId);
  const l = lineId == null ? '' : String(lineId);
  if (!isPoLinePart(p) || !isPoLinePart(l)) return null;
  return `${p}:${l}`;
}

/** { poId, lineId } from a 'po_line' target, or null when it is not one. */
function parsePoLineTarget(t) {
  if (typeof t !== 'string') return null;
  const i = t.indexOf(':');
  if (i < 0) return null;
  const poId = t.slice(0, i);
  const lineId = t.slice(i + 1);
  if (!isPoLinePart(poId) || !isPoLinePart(lineId)) return null;
  return { poId, lineId };
}

/** The line with this id on the order, or null. */
function findLine(po, lineId) {
  if (!po || !Array.isArray(po.lines) || lineId == null) return null;
  const want = String(lineId);
  return po.lines.find(l => l && l.id != null && String(l.id) === want) || null;
}

const codeText = v => {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * The split a delivery is on, when its order is split between jobs and the
 * split has a job — see "One order, several jobs" in api/lib/po-sync.js
 * (lineJob there makes the same call; kept here so this file stays pure).
 */
function lineSplit(po, line) {
  const id = line && line.split != null ? String(line.split).trim() : '';
  if (!id || !po || !Array.isArray(po.splits)) return null;
  const s = po.splits.find(x => x && typeof x === 'object' && String(x.id == null ? '' : x.id).trim() === id);
  return s && s.project_id ? s : null;
}

/**
 * The cost code a delivery's file compiles under: the line's own code when it
 * carries one (a Daily Tracking line carries its row's code, which can differ
 * from the order header's — api/lib/po-sync.js applyRowToLine), else its
 * split's when the order is split between jobs, else the order's. Raw, as
 * stored: the cost-code folder lookup matches the exact raw code first. null
 * when none has one.
 */
function lineCostCode(po, line) {
  const own = line && typeof line.cost_code === 'string' && line.cost_code.trim() ? line.cost_code : null;
  if (own) return own;
  const split = lineSplit(po, line);
  if (split) return codeText(split.cost_code);
  return po ? codeText(po.cost_code) : null;
}

/**
 * The job a delivery is on: its split's, else the order's. The file itself is
 * filed under the order, in the order's job, and compiles in a cost-code
 * folder only when this is that job (api/documents.js fileLineUnderCostCode).
 */
function lineProjectId(po, line) {
  const split = lineSplit(po, line);
  if (split) return String(split.project_id);
  return po && po.project_id ? String(po.project_id) : null;
}

module.exports = {
  PO_LINE_PART_RE,
  isPoLinePart,
  poLineTarget,
  parsePoLineTarget,
  findLine,
  lineCostCode,
  lineProjectId,
};
