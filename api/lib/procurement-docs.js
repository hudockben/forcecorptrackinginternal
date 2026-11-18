'use strict';
/**
 * Procurement line attachments, and the cost-code folders they compile into.
 *
 * A file attached to a line on the Procurement sheet is ONE project_documents
 * row with several document_links:
 *   - a 'folder' link to the folder the person picked in the upload dialog,
 *   - a 'procurement' link per line it is attached to (target_id is the
 *     procurement_items id), and
 *   - a 'folder' link to each such line's cost-code folder in the Job
 *     Document Vault, so the cost-code folder "compiles" every attachment of
 *     every line in that section without storing a file twice.
 *
 * Both api/documents.js (attach, at upload or after the fact) and
 * api/procurement.js (re-file when a line's cost code changes) need the same
 * three answers — what is this line's cost code right now, which folder is
 * that code's, and make that folder if it is missing — so they live here, once.
 *
 * Nothing in here throws at its caller where that would cost the person their
 * write: a file that cannot get its cost-code folder is still filed in the
 * folder they picked, and a re-file that fails must never fail the procurement
 * save that triggered it. Those paths catch, log and carry on.
 */

const crypto = require('crypto');

// Where each division keeps a job's blob, the bid (bidItems) included — the
// keys api/bid-items.js and the pages write. api/procurement.js reads its
// bid-line checks from the same table, so there is one copy of this map.
const PROJECT_KEY_PREFIX = { turf: 'fct_project_', paving: 'fct_paving_project_', kiewit: 'fct_kiewit_project_' };

// A division with no job blobs (or no Procurement) has no bid to read a live
// code from: null makes the bid-line join below match nothing, and every row
// falls back to its stored copy.
const bidKeyPrefix = (company, division) =>
  (PROJECT_KEY_PREFIX[division] ? `${company}:${PROJECT_KEY_PREFIX[division]}` : null);

// Procurement row ids are minted by the page (procurement.js uid()) and held
// to this shape by api/procurement.js. Anything else cannot be a row.
const PROCUREMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Where an auto-created cost-code folder sorts until the next folder seed
// re-sorts it among the job's other cost codes: after the standard folders and
// Purchase Orders, before folders people make by hand (900).
const COST_CODE_SORT = 800;

// How many " (n)" suffixes to try when a folder someone made by hand already
// has the code's name at the top of the job's tree.
const MAX_NAME_SUFFIX = 9;

function newId() {
  return crypto.randomUUID();
}

function isUniqueViolation(err) {
  return Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
}

const isProcurementId = v => typeof v === 'string' && PROCUREMENT_ID_RE.test(v);

// Two codes are the same section when they read the same on screen — the rule
// the folder lookup below uses, so "is this a change?" and "which folder is
// that?" never disagree.
//
// The same normalising as tracker.html's _codeKey, which is what the
// Procurement sheet groups its sections by, and as codeKey in documents.js,
// which the section folder chips count by: letter case, spaces at either end
// or doubled up (the non-breaking kind a paste out of Procore or Excel brings
// included), zero-width characters, which dash was typed ("-", "–", "—") and
// curly or straight quotes do not make two codes different. Postgres btrim()
// and lower() cannot be used for this: btrim strips only the plain space, so a
// bid code pasted as "Stormwater" plus a non-breaking space never matched a
// line stored as "Stormwater", and attaching a file to that line made a second
// "Stormwater" folder beside the one the bid seeded.
function codeKey(v) {
  if (v == null || v === '') return '';
  return String(v)
    .replace(/[­​-‍⁠﻿]/g, '')          // soft hyphen, zero-width
    .replace(/[‐-―−﹘﹣－]/g, '-')   // every dash
    .replace(/[‘’‚‛′]/g, "'")          // curly single quotes
    .replace(/[“”„‟″]/g, '"')          // curly double quotes
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// The same row shape api/documents.js writes. A failed audit write is logged
// and swallowed: losing the trail of a re-file is not worth losing the re-file.
async function audit(sql, { companyCode, division, documentId, folderId, projectId, action, username, userId, detail }) {
  try {
    await sql`
      INSERT INTO document_audit_log
        (company_code, division, document_id, folder_id, project_id, action, actor, actor_id, detail)
      VALUES
        (${companyCode}, ${division}, ${documentId || null}, ${folderId || null}, ${projectId || null},
         ${action}, ${username || null}, ${userId || null},
         ${detail ? JSON.stringify(detail) : null})
    `;
  } catch (err) {
    console.warn(`[procurement-docs] audit ${action} failed: ${err.message}`);
  }
}

/**
 * Each row's cost code as the Procurement sheet shows it right now.
 *
 * The same rule as procurement.js liveCodes(): while the row's bid_item_id is
 * a line on the job's stored bid, that line's cost_code is the code (it may be
 * blank); otherwise the row's own stored copy. The stored copy can be stale —
 * a bid line renamed on the bid page changes the live code at once and the
 * copy only later — so filing by the stored copy alone would put a file in a
 * folder the sheet no longer shows the line under.
 *
 * One query for any number of rows. Returns Map(rowId -> { projectId, code,
 * rawCode, deleted }): `code` is trimmed and is what decides "no cost code"
 * (''); `rawCode` is the code exactly as the bid holds it, which is what a new
 * folder is created with, because the folder seed matches a cost-code folder
 * by its exact raw code and would otherwise make a second one beside it.
 * Rows of another company or division are simply absent.
 */
async function liveCostCodes(sql, { companyCode, division, rowIds }) {
  const ids = [...new Set((rowIds || []).filter(isProcurementId))];
  const out = new Map();
  if (!ids.length) return out;
  const keyPrefix = bidKeyPrefix(companyCode, division);
  // The LAST bid line with the id wins, as it does in the page's own index
  // (a Map filled in bid order). A line whose cost_code is missing, null or
  // not text reads as '' — "on the bid, with no code" — exactly as the page
  // reads it, rather than falling through to the stored copy.
  const rows = await sql`
    SELECT p.id, p.project_id, (p.deleted_at IS NOT NULL) AS deleted,
           p.cost_code AS stored_code, bl.code AS line_code, (bl.found IS NOT NULL) AS on_bid
      FROM procurement_items p
      LEFT JOIN LATERAL (
        SELECT TRUE AS found,
               CASE WHEN jsonb_typeof(e.v->'cost_code') IN ('string', 'number')
                    THEN e.v->>'cost_code' ELSE '' END AS code
          FROM app_data a
         CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(a.value->'bidItems') = 'array' THEN a.value->'bidItems' ELSE '[]'::jsonb END)
                WITH ORDINALITY AS e(v, ord)
         WHERE p.bid_item_id IS NOT NULL
           AND a.key = ${keyPrefix}::text || p.project_id
           AND e.v->>'id' = p.bid_item_id
         ORDER BY e.ord DESC
         LIMIT 1
      ) bl ON TRUE
     WHERE p.company_code = ${companyCode} AND p.division = ${division}
       AND p.id = ANY(${ids}::text[])
  `;
  for (const r of rows) {
    const rawCode = r.on_bid ? String(r.line_code == null ? '' : r.line_code) : String(r.stored_code == null ? '' : r.stored_code);
    out.set(r.id, { projectId: r.project_id, code: rawCode.trim(), rawCode, deleted: Boolean(r.deleted) });
  }
  return out;
}

/**
 * How well folder `f` stands for a cost code, or -1 when it does not: lower
 * is better. `raw` is the code as given, `trimmed` and `key` its trimmed and
 * codeKey forms.
 *
 *   0  the exact raw code — a line tied to a bid line lands in the very folder
 *      the seed made from that line, even beside a near-identical one;
 *   1  the same code with the spaces around it trimmed (any kind of space);
 *   2  the same code as it reads on screen (codeKey: case, dashes, quotes,
 *      doubled or non-breaking spaces) — a hand-added line typed "stormwater"
 *      belongs in the bid's "Stormwater" folder, not in a second one;
 *   3  a cost-code folder from before the cost_code column, known only by the
 *      seed's slug "cc-<code>";
 *   4  that slug, read the way rank 2 reads a code.
 */
function costCodeRank(f, raw, trimmed, key) {
  if (!f) return -1;
  if (f.kind === 'cost_code' && f.cost_code != null && f.cost_code !== '') {
    const c = String(f.cost_code);
    if (c === raw) return 0;
    if (c.trim() === trimmed) return 1;
    if (key && codeKey(c) === key) return 2;
  }
  const slug = f.slug == null ? '' : String(f.slug);
  if (slug.startsWith('cc-')) {
    if (slug === 'cc-' + raw || slug === 'cc-' + trimmed) return 3;
    if (key && codeKey(slug.slice(3)) === key) return 4;
  }
  return -1;
}

/**
 * The job's folder for one cost code, or null.
 *
 * Cost-code folders are made by the folder seed (api/documents.js PUT) from the
 * bid's codes, and by ensureCostCodeFolder below. Looked up in the order
 * costCodeRank gives; among folders that match equally well, the one sorted
 * first in the job's tree. Only in this one job's tree — the same code on
 * another job, in another division or company, is another folder.
 *
 * The match is made here rather than in SQL, so it is the same codeKey rule
 * the Procurement sheet groups by, character for character (Postgres cannot
 * strip a non-breaking space without spelling out every Unicode space). A job
 * has tens of cost-code folders at most, so reading them all costs nothing.
 */
async function findCostCodeFolder(sql, { companyCode, division, projectId, code }) {
  const raw = code == null ? '' : String(code);
  const trimmed = raw.trim();
  if (!trimmed || !projectId) return null;
  const key = codeKey(raw);
  const rows = await sql`
    SELECT id, kind, slug, cost_code, sort_order, created_at
      FROM project_folders
     WHERE company_code = ${companyCode} AND division = ${division}
       AND COALESCE(project_id, '') = ${String(projectId)}
       AND (kind = 'cost_code' OR slug LIKE 'cc-%')
  `;
  const when = v => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const hits = [];
  for (const f of rows) {
    const rank = costCodeRank(f, raw, trimmed, key);
    if (rank >= 0) hits.push({ f, rank });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (a.rank - b.rank)
    || ((Number(a.f.sort_order) || 0) - (Number(b.f.sort_order) || 0))
    || (when(a.f.created_at) - when(b.f.created_at))
    || (String(a.f.id) < String(b.f.id) ? -1 : String(a.f.id) > String(b.f.id) ? 1 : 0));
  return hits[0].f.id;
}

/**
 * The job's folder for one cost code, made if it is missing. Returns its id,
 * or null — never throws.
 *
 * Missing happens: the folder seed only runs when someone opens the job's
 * Documents tab, and a hand-added line can carry a code the bid does not. The
 * folder is made exactly as the seed would make it — at the top of the tree,
 * kind 'cost_code', slug 'cc-<code>', cost_code the code — named with the bare
 * code, because only the browser holds the cost-code master list the label
 * comes from. The next seed finds it by its cost_code, relabels it
 * "<code> · <label>" and sorts it among the others, rather than adding a
 * second folder for the same code.
 *
 * When the bare code is already the name of a folder somebody made by hand at
 * the top of the job, the new folder is suffixed " (2)" and so on, as the seed
 * does: the file still lands in a real cost-code folder, never in theirs.
 */
async function ensureCostCodeFolder(sql, { companyCode, division, projectId, code, username, userId }) {
  try {
    const raw = code == null ? '' : String(code);
    if (!raw.trim() || !projectId) return null;
    const hit = await findCostCodeFolder(sql, { companyCode, division, projectId, code: raw });
    if (hit) return hit;

    for (let attempt = 1; attempt <= MAX_NAME_SUFFIX; attempt++) {
      const name = attempt === 1 ? raw : `${raw} (${attempt})`;
      const id = newId();
      try {
        await sql`
          INSERT INTO project_folders
            (id, company_code, division, project_id, parent_id, name, kind, slug, cost_code, sort_order, created_by)
          VALUES
            (${id}, ${companyCode}, ${division}, ${String(projectId)}, NULL, ${name},
             'cost_code', ${'cc-' + raw}, ${raw}, ${COST_CODE_SORT}, ${username || null})
        `;
        await audit(sql, {
          companyCode, division, projectId, folderId: id, action: 'FOLDER_CREATE', username, userId,
          detail: { generated: [name], cost_code: raw, via: 'procurement_cost_code' },
        });
        return id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Someone made the same folder a moment ago (a colleague attaching to
        // another line of the same section, or the seed) — use theirs.
        const back = await findCostCodeFolder(sql, { companyCode, division, projectId, code: raw });
        if (back) return back;
        // Otherwise the name belongs to a folder that is not this code's.
        // Try the next suffix.
      }
    }
    console.warn(`[procurement-docs] no free name for the cost-code folder "${raw}" on job ${projectId}`);
    return null;
  } catch (err) {
    console.warn(`[procurement-docs] cost-code folder "${code}" on job ${projectId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Of the given rows, the ones that have something attached, with the cost code
 * each one stores right now: Map(rowId -> stored cost_code).
 *
 * Read BEFORE a procurement write that can change a row's code, so the re-file
 * after it knows where the files were. Rows with nothing attached are left
 * out, which is what keeps a code change on a line with no files at one extra
 * query. Deleted rows are included: restoring one can re-tie it to a new line.
 */
async function snapshotStoredCodes(sql, { companyCode, division, rowIds }) {
  const ids = [...new Set((rowIds || []).filter(isProcurementId))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await sql`
    SELECT p.id, p.cost_code
      FROM procurement_items p
     WHERE p.company_code = ${companyCode} AND p.division = ${division}
       AND p.id = ANY(${ids}::text[])
       AND EXISTS (
             SELECT 1 FROM document_links l
              WHERE l.company_code = p.company_code
                AND l.link_type    = 'procurement'
                AND l.target_id    = p.id
           )
  `;
  for (const r of rows) out.set(r.id, r.cost_code == null ? '' : String(r.cost_code));
  return out;
}

/**
 * Move a line's files to its new cost code's folder after its code changed.
 *
 * changes = [{ rowId, projectId, fromCode, toCode }], fromCode being the code
 * the row stored before the write and toCode its live code after it. For every
 * live document in this company and division attached to the row (and filed
 * in the row's job):
 *   1. it is filed in toCode's folder, made if missing, when toCode is a code;
 *   2. it leaves fromCode's folder — but only when nothing still puts it there:
 *      not when another live line it is attached to still sits under fromCode,
 *      and not when that folder is the only one it is in (a file is never left
 *      filed nowhere; a line whose code was blanked keeps its file where it was);
 *   3. each link made or removed is written to the document audit trail.
 *
 * Never throws. The procurement save that triggered it has already landed, and
 * a file left in its old folder is a tidy-up, not lost work.
 */
async function refileProcurementDocs(sql, { companyCode, division, username, userId, changes }) {
  try {
    const wanted = (changes || []).filter(c => c && isProcurementId(c.rowId) && c.projectId
      && codeKey(c.fromCode) !== codeKey(c.toCode));
    if (!wanted.length) return;

    // Every attached live document of every changed row, in one read.
    const rowIds = [...new Set(wanted.map(c => c.rowId))];
    const attached = await sql`
      SELECT l.target_id AS row_id, d.id AS document_id, COALESCE(d.project_id, '') AS project_id
        FROM document_links l
        JOIN project_documents d ON d.id = l.document_id
       WHERE l.company_code = ${companyCode}
         AND l.link_type    = 'procurement'
         AND l.target_id    = ANY(${rowIds}::text[])
         AND d.company_code = ${companyCode}
         AND d.division     = ${division}
         AND d.deleted_at IS NULL
    `;
    if (!attached.length) return;

    for (const change of wanted) {
      try {
        const projectId = String(change.projectId);
        // Only files in the row's own job: a file re-homed to the General area
        // by a restore is not put back into a job's tree from here.
        const docIds = [...new Set(attached
          .filter(a => a.row_id === change.rowId && a.project_id === projectId)
          .map(a => a.document_id))];
        if (!docIds.length) continue;

        const scope = { companyCode, division, projectId };
        const toFolder = codeKey(change.toCode)
          ? await ensureCostCodeFolder(sql, { ...scope, code: change.toCode, username, userId })
          : null;
        const fromFolder = codeKey(change.fromCode)
          ? await findCostCodeFolder(sql, { ...scope, code: change.fromCode })
          : null;

        const detail = folderId => ({
          link_type: 'folder', target_id: folderId, via: 'procurement_cost_code', procurement_id: change.rowId,
        });

        // 1. Into the new code's folder.
        if (toFolder) {
          for (const documentId of docIds) {
            const made = await sql`
              INSERT INTO document_links (document_id, company_code, link_type, target_id, created_by)
              VALUES (${documentId}, ${companyCode}, 'folder', ${toFolder}, ${username || null})
              ON CONFLICT DO NOTHING
              RETURNING id
            `;
            if (made.length) {
              await audit(sql, {
                ...scope, documentId, folderId: toFolder, action: 'LINK', username, userId, detail: detail(toFolder),
              });
            }
          }
        }

        // 2. Out of the old code's folder, where nothing else keeps it there.
        if (!fromFolder || fromFolder === toFolder) continue;
        const fromKey = codeKey(change.fromCode);

        // The other lines each document is attached to, and their live codes.
        const others = await sql`
          SELECT document_id, target_id
            FROM document_links
           WHERE document_id = ANY(${docIds}::text[])
             AND company_code = ${companyCode}
             AND link_type    = 'procurement'
             AND target_id   <> ${change.rowId}
        `;
        const otherCodes = others.length
          ? await liveCostCodes(sql, { companyCode, division, rowIds: others.map(o => o.target_id) })
          : new Map();

        for (const documentId of docIds) {
          const stillThere = others.some(o => {
            if (o.document_id !== documentId) return false;
            const live = otherCodes.get(o.target_id);
            return Boolean(live) && !live.deleted && codeKey(live.code) === fromKey;
          });
          if (stillThere) continue;

          // A file must stay filed somewhere a person can reach. Counted the
          // way api/documents.js counts it: links to folders that exist.
          const homes = await sql`
            SELECT COUNT(*)::int AS n
              FROM document_links l
              JOIN project_folders f ON f.id = l.target_id
             WHERE l.document_id = ${documentId}
               AND l.link_type   = 'folder'
               AND l.target_id  <> ${fromFolder}
               AND f.company_code = ${companyCode}
               AND f.division     = ${division}
          `;
          if (!homes[0] || !homes[0].n) continue;

          const gone = await sql`
            DELETE FROM document_links
             WHERE document_id = ${documentId} AND link_type = 'folder' AND target_id = ${fromFolder}
            RETURNING id
          `;
          if (gone.length) {
            await audit(sql, {
              ...scope, documentId, folderId: fromFolder, action: 'UNLINK', username, userId, detail: detail(fromFolder),
            });
          }
        }
      } catch (err) {
        // One line's re-file failing must not stop the others.
        console.warn(`[procurement-docs] re-file of procurement line ${change.rowId} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[procurement-docs] re-file failed: ${err.message}`);
  }
}

module.exports = {
  PROJECT_KEY_PREFIX,
  PROCUREMENT_ID_RE,
  COST_CODE_SORT,
  bidKeyPrefix,
  isProcurementId,
  codeKey,
  liveCostCodes,
  findCostCodeFolder,
  ensureCostCodeFolder,
  snapshotStoredCodes,
  refileProcurementDocs,
};
