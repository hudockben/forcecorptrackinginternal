'use strict';
/**
 * How many documents each cost code's folder holds on one job — the number
 * on the folder chips of the Procurement sheet's sections and the bid page's
 * green cost-code bars.
 *
 * The browser used to work this out itself from the job's whole listing
 * (GET /api/documents?projectId=, every folder and every document), and the
 * Procurement sheet asks again on every 60-second poll. This answers the same
 * question with only the numbers: GET /api/documents?costCodeCounts=1.
 *
 * The rules are documents.js's (folderCostCode, sameCodeFolders, subtreeIds,
 * countByCostCode), carried over line for line and run over the same rows the
 * listing returns, in the same order — so a chip counts exactly what it
 * counted before, and the codeKey fallback in costCodeCount() finds the same
 * folder first. scripts/test-documents-frontend.js holds the two copies to
 * each other.
 */

/* The cost code a generated folder stands for, or '' if it stands for none:
   the cost_code column, trimmed, or for a folder seeded before that column
   existed the code in its `cc-<code>` slug. Only folders of kind 'cost_code'. */
function folderCostCode(f) {
  if (!f || f.kind !== 'cost_code') return '';
  if (f.cost_code) return String(f.cost_code).trim();
  const m = /^cc-(.+)$/.exec(f.slug || '');
  return m ? m[1].trim() : '';
}

/* `folder` and every other cost-code folder standing for the same trimmed
   code (a bid that carries a code once as typed and once with a trailing
   non-breaking space seeds one folder for each). */
function sameCodeFolders(folder, fldrs) {
  const code = folderCostCode(folder);
  if (!code) return folder ? [folder] : [];
  return fldrs.filter(f => f === folder || folderCostCode(f) === code);
}

/* Every folder id at or under `rootId` — subfolders filed inside a cost-code
   folder ("420 / Tickets") count toward its code. */
function subtreeIds(rootId, fldrs) {
  const kids = new Map();
  for (const f of fldrs) {
    const p = f.parent_id || null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f.id);
  }
  const ids = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const k of (kids.get(stack.pop()) || [])) {
      if (!ids.has(k)) { ids.add(k); stack.push(k); }
    }
  }
  return ids;
}

function subtreesOf(roots, fldrs) {
  const ids = new Set();
  for (const r of roots) for (const id of subtreeIds(r.id, fldrs)) ids.add(id);
  return ids;
}

/* { '420': 7, '530': 0, ... }: every cost-code folder reported, zeroes
   included; folders whose codes trim to the same code counted as one, each
   document once however many of them it is in. `docs` are { folder_ids }. */
function countByCostCode(fldrs, docs) {
  const counts = {};
  for (const f of fldrs) {
    const code = folderCostCode(f);
    if (!code || Object.prototype.hasOwnProperty.call(counts, code)) continue;
    const ids = subtreesOf(sameCodeFolders(f, fldrs), fldrs);
    counts[code] = docs.filter(d => (d.folder_ids || []).some(id => ids.has(id))).length;
  }
  return counts;
}

/**
 * One job's counts, read straight from the database: the job's folders in the
 * listing's order (sort_order, then name), and the folder links of its live
 * documents — only those into a cost-code folder's subtree, which is all the
 * count looks at. projectId null/'' is the General / Non-Job area, as in the
 * listing. Two small reads; nothing about the documents themselves leaves the
 * server.
 */
async function costCodeCounts(sql, { companyCode, division, projectId }) {
  const scope = projectId || '';
  const folders = await sql`
    SELECT id, parent_id, kind, slug, cost_code
    FROM   project_folders
    WHERE  company_code = ${companyCode}
      AND  division     = ${division}
      AND  COALESCE(project_id, '') = ${scope}
    ORDER  BY sort_order ASC, name ASC
  `;
  const roots = folders.filter(f => folderCostCode(f));
  if (!roots.length) return {};

  const wanted = [...subtreesOf(roots, folders)];
  const links = await sql`
    SELECT l.document_id, l.target_id
    FROM   project_documents d
    JOIN   document_links l ON l.document_id = d.id AND l.link_type = 'folder'
    WHERE  d.company_code = ${companyCode}
      AND  d.division     = ${division}
      AND  COALESCE(d.project_id, '') = ${scope}
      AND  d.deleted_at IS NULL
      AND  l.target_id = ANY(${wanted}::text[])
  `;
  const byDoc = new Map();
  for (const r of links) {
    if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, []);
    byDoc.get(r.document_id).push(r.target_id);
  }
  return countByCostCode(folders, [...byDoc.values()].map(folder_ids => ({ folder_ids })));
}

/**
 * A fingerprint of everything one job's listing shows: its folders (name,
 * place, kind, code, order), its live documents (name, note, type, size,
 * who and when) and every link they hang by. It changes whenever any of
 * that does, and only then.
 *
 * The listing (GET ?projectId=) carries it, and so does every count answer
 * (GET ?costCodeCounts=1). documents.js keeps the one its copy of the job
 * came with; a poll whose answer carries another knows that copy is behind
 * — a file swapped for another, a folder made, a note edited — even when
 * not one count moved, and without fetching the listing to find out.
 *
 * One aggregate row, read in the database. The listing reads it BEFORE its
 * folders and documents, so a change that lands in between leaves the
 * listing carrying an older fingerprint than its contents: the next poll
 * then reads the job again (harmless), instead of the reverse, where a copy
 * that missed a change would carry the fingerprint that says it had it.
 */
async function scopeVersion(sql, { companyCode, division, projectId }) {
  const scope = projectId || '';
  const rows = await sql`
    SELECT md5(COALESCE(string_agg(x, E'\n' ORDER BY x), '')) AS v
    FROM (
      SELECT concat_ws('|', 'f', f.id, COALESCE(f.parent_id, ''), f.name, f.kind, COALESCE(f.slug, ''),
                       COALESCE(f.cost_code, ''), f.sort_order::text, f.archived::text) AS x
        FROM project_folders f
       WHERE f.company_code = ${companyCode} AND f.division = ${division}
         AND COALESCE(f.project_id, '') = ${scope}
      UNION ALL
      SELECT concat_ws('|', 'd', d.id, d.filename, COALESCE(d.content_type, ''), d.size_bytes::text,
                       COALESCE(d.note, ''), COALESCE(d.uploaded_by, ''), d.uploaded_at::text)
        FROM project_documents d
       WHERE d.company_code = ${companyCode} AND d.division = ${division}
         AND COALESCE(d.project_id, '') = ${scope} AND d.deleted_at IS NULL
      UNION ALL
      SELECT concat_ws('|', 'l', l.document_id, l.link_type, l.target_id)
        FROM document_links l
        JOIN project_documents d ON d.id = l.document_id
       WHERE d.company_code = ${companyCode} AND d.division = ${division}
         AND COALESCE(d.project_id, '') = ${scope} AND d.deleted_at IS NULL
    ) t
  `;
  return rows[0] && rows[0].v ? String(rows[0].v) : null;
}

module.exports = { folderCostCode, countByCostCode, costCodeCounts, scopeVersion };
