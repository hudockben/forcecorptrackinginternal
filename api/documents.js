'use strict';
/**
 * Job document vault — folders, documents, and their links.
 *
 * GET    /api/documents?division=turf&projectId=X   — { folders, documents } for one job
 * GET    /api/documents?division=turf               — the division-level General / Non-Job area
 * GET    /api/documents?division=turf&poId=X        — documents attached to one purchase order
 * GET    /api/documents?division=turf&poCounts=1    — { counts: { poId: n } } for the paperclip badges
 * GET    /api/documents?division=turf&trash=1       — soft-deleted documents inside the 30-day window
 * PUT    /api/documents?division=turf&projectId=X   — ensure the generated folder tree exists
 * POST   /api/documents?division=turf               — register a file the browser just uploaded
 * POST   /api/documents?division=turf&folder=1      — create one user folder
 * PATCH  /api/documents?division=turf&id=X          — rename, re-file, link, unlink, restore
 * DELETE /api/documents?division=turf&id=X          — soft delete (admin only)
 * DELETE /api/documents?division=turf&folderId=X    — delete an empty user folder
 *
 * File BYTES never pass through here — the browser PUTs them straight to
 * object storage with a presigned URL from api/document-upload-url.js, then
 * POSTs the metadata to this endpoint. See api/lib/storage.js for why.
 *
 * project_id NULL means the division-level General / Non-Job area, which is
 * where purchase orders with no job attached file their paperwork.
 */
const { neon }            = require('@neondatabase/serverless');
const { requireDivision } = require('./lib/auth');
const storage             = require('./lib/storage');
const crypto              = require('crypto');

// The six standard folders every job gets, in the order they render.
//
// `slug` is the folder's real identity and `name` only its opening label: a PM
// who renames 'Photos' to 'Site Photos' keeps that name, because the generator
// below matches on slug. Matching on the name instead recreated the original
// alongside the renamed one every time the tab opened.
const FIXED_FOLDERS = [
  { slug: 'contract-change-orders', name: 'Contract & Change Orders' },
  { slug: 'permits-insurance',      name: 'Permits & Insurance' },
  { slug: 'submittals',             name: 'Submittals' },
  { slug: 'safety',                 name: 'Safety' },
  { slug: 'photos',                 name: 'Photos' },
  { slug: 'closeout',               name: 'Closeout' },
];

// Purchase-order paperwork lands under this folder, one subfolder per PO.
const PO_ROOT = { slug: 'purchase-orders', name: 'Purchase Orders' };

// Division-level buckets for POs with no job attached.
const GENERAL_FOLDERS = [
  { slug: 'shop-supplies',  name: 'Shop Supplies' },
  { slug: 'office',         name: 'Office' },
  { slug: 'unassigned-pos', name: 'Unassigned POs' },
];

const TRASH_WINDOW_DAYS = 30;

/**
 * Capability level for this caller in this division.
 *
 * payload.role is the *turf* role (login.js sets it from divisionRoles.turf
 * for tracker.html's benefit), so it is only correct for turf. Reading
 * divisionRoles[division] first keeps this right when the vault reaches
 * paving and kiewit.
 */
function levelFor(payload, division) {
  if (payload.isPlatformAdmin) return 'admin';
  const dr = payload.divisionRoles;
  if (dr && typeof dr === 'object' && dr[division] && dr[division] !== 'no_access') {
    return dr[division];
  }
  return payload.role || 'level1';
}

/**
 * What this caller may do. Mirrors the `perm` object in tracker.html:
 *   level1  view only
 *   level2  upload, and unfile their own uploads
 *   level3  everything except destroying a file
 *   admin   destroy
 */
function capabilities(payload, division) {
  const level = levelFor(payload, division);
  return {
    level,
    canUpload: ['admin', 'level3', 'level2'].includes(level),
    canManage: ['admin', 'level3'].includes(level),
    canDelete: level === 'admin',
  };
}

function newId() {
  return crypto.randomUUID();
}

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
}

async function audit(sql, { companyCode, division, documentId, folderId, projectId, action, payload, detail }) {
  try {
    await sql`
      INSERT INTO document_audit_log
        (company_code, division, document_id, folder_id, project_id, action, actor, actor_id, detail)
      VALUES
        (${companyCode}, ${division}, ${documentId || null}, ${folderId || null}, ${projectId || null},
         ${action}, ${payload.username || null}, ${payload.userId || null},
         ${detail ? JSON.stringify(detail) : null})
    `;
  } catch (err) {
    // An audit write must never take the user's action down with it.
    console.warn(`[documents] audit ${action} failed: ${err.message}`);
  }
}

// Shape a folder row for the browser.
function folderOut(r) {
  return {
    id: r.id,
    parent_id: r.parent_id,
    name: r.name,
    kind: r.kind,
    slug: r.slug,
    cost_code: r.cost_code,
    sort_order: r.sort_order,
    archived: r.archived,
  };
}

function documentOut(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    filename: r.filename,
    content_type: r.content_type,
    size_bytes: Number(r.size_bytes) || 0,
    note: r.note,
    uploaded_by: r.uploaded_by,
    uploaded_at: r.uploaded_at,
    deleted_at: r.deleted_at || null,
    folder_ids: Array.isArray(r.folder_ids) ? r.folder_ids : [],
    po_ids: Array.isArray(r.po_ids) ? r.po_ids : [],
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = requireDivision(req, res);
  if (!guard) return;
  const { payload, division } = guard;
  const { companyCode } = payload;
  const caps = capabilities(payload, division);

  const sql = neon(process.env.DATABASE_URL);
  // '' and undefined both mean "the division-level General area".
  const projectId = req.query.projectId ? String(req.query.projectId) : null;

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (req.query.poCounts) {
        const rows = await sql`
          SELECT l.target_id AS po_id, COUNT(*)::int AS n
          FROM   document_links l
          JOIN   project_documents d ON d.id = l.document_id
          WHERE  l.company_code = ${companyCode}
            AND  l.link_type    = 'po'
            AND  d.division     = ${division}
            AND  d.deleted_at IS NULL
          GROUP BY l.target_id
        `;
        const counts = {};
        for (const r of rows) counts[r.po_id] = r.n;
        return res.json({ counts });
      }

      if (req.query.poId) {
        const rows = await sql`
          SELECT
          d.id, d.project_id, d.filename, d.content_type, d.size_bytes, d.note,
          d.uploaded_by, d.uploaded_at, d.deleted_at,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'folder'), '[]'::jsonb) AS folder_ids,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'po'),     '[]'::jsonb) AS po_ids
          FROM   project_documents d
          LEFT   JOIN document_links l ON l.document_id = d.id
          WHERE  d.company_code = ${companyCode}
            AND  d.division     = ${division}
            AND  d.deleted_at IS NULL
            AND  EXISTS (
                   SELECT 1 FROM document_links pl
                   WHERE pl.document_id = d.id
                     AND pl.link_type   = 'po'
                     AND pl.target_id   = ${String(req.query.poId)}
                 )
          GROUP BY d.id
          ORDER BY d.uploaded_at DESC
        `;
        return res.json({ documents: rows.map(documentOut) });
      }

      if (req.query.trash) {
        const rows = await sql`
          SELECT
          d.id, d.project_id, d.filename, d.content_type, d.size_bytes, d.note,
          d.uploaded_by, d.uploaded_at, d.deleted_at,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'folder'), '[]'::jsonb) AS folder_ids,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'po'),     '[]'::jsonb) AS po_ids
          FROM   project_documents d
          LEFT   JOIN document_links l ON l.document_id = d.id
          WHERE  d.company_code = ${companyCode}
            AND  d.division     = ${division}
            AND  d.deleted_at IS NOT NULL
            AND  (d.purge_after IS NULL OR d.purge_after > NOW())
          GROUP BY d.id
          ORDER BY d.deleted_at DESC
        `;
        return res.json({ documents: rows.map(documentOut) });
      }

      const folders = await sql`
        SELECT * FROM project_folders
        WHERE  company_code = ${companyCode}
          AND  division     = ${division}
          AND  project_id IS NOT DISTINCT FROM ${projectId}
        ORDER  BY sort_order ASC, name ASC
      `;

      const documents = await sql`
          SELECT
          d.id, d.project_id, d.filename, d.content_type, d.size_bytes, d.note,
          d.uploaded_by, d.uploaded_at, d.deleted_at,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'folder'), '[]'::jsonb) AS folder_ids,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'po'),     '[]'::jsonb) AS po_ids
        FROM   project_documents d
        LEFT   JOIN document_links l ON l.document_id = d.id
        WHERE  d.company_code = ${companyCode}
          AND  d.division     = ${division}
          AND  d.project_id IS NOT DISTINCT FROM ${projectId}
          AND  d.deleted_at IS NULL
        GROUP  BY d.id
        ORDER  BY d.uploaded_at DESC
      `;

      return res.json({
        folders:   folders.map(folderOut),
        documents: documents.map(documentOut),
        caps,
      });
    }

    // ── PUT — ensure the generated folder tree ───────────────────────────
    // Called when a job's Documents tab opens. Creates the six fixed folders,
    // the Purchase Orders root, and one folder per cost code on the job.
    // Idempotent: existing folders are left exactly as they are, including any
    // the user renamed.
    if (req.method === 'PUT') {
      if (!caps.canUpload) {
        return res.status(403).json({ error: 'You do not have permission to change folders' });
      }

      const body = req.body || {};
      // [{ code, label }] — label already resolved against the cost-code master
      // list by the caller, since only the frontend holds fct_lists.
      const costCodes = Array.isArray(body.costCodes) ? body.costCodes : [];

      const existing = await sql`
        SELECT * FROM project_folders
        WHERE  company_code = ${companyCode}
          AND  division     = ${division}
          AND  project_id IS NOT DISTINCT FROM ${projectId}
      `;

      const bySlug     = new Map(existing.filter(f => f.slug).map(f => [f.slug, f]));
      const byCostCode = new Map(existing.filter(f => f.cost_code).map(f => [f.cost_code, f]));
      const created = [];

      // `name` is only the opening label. A folder is identified by its slug
      // (fixed folders) or its cost code, so user renames survive every
      // subsequent call.
      async function ensure({ slug, name, kind, costCode, sortOrder, parentId }) {
        const hit = costCode ? byCostCode.get(costCode) : bySlug.get(slug);
        if (hit) return hit.id;
        const id = newId();
        try {
          await sql`
            INSERT INTO project_folders
              (id, company_code, division, project_id, parent_id, name, kind, slug, cost_code, sort_order, created_by)
            VALUES
              (${id}, ${companyCode}, ${division}, ${projectId}, ${parentId || null}, ${name},
               ${kind}, ${slug || null}, ${costCode || null}, ${sortOrder}, ${payload.username || null})
          `;
          created.push({ id, name, kind });
          return id;
        } catch (err) {
          // Two users opening the same job at once both try to seed it. The
          // unique index settles it; the loser reads back the winner's row.
          if (!isUniqueViolation(err)) throw err;
          const back = await sql`
            SELECT id FROM project_folders
            WHERE company_code = ${companyCode} AND division = ${division}
              AND project_id IS NOT DISTINCT FROM ${projectId}
              AND (slug = ${slug || null} OR lower(name) = ${String(name).toLowerCase()})
            LIMIT 1
          `;
          return back.length ? back[0].id : null;
        }
      }

      if (projectId) {
        let sort = 0;
        for (const f of FIXED_FOLDERS) {
          await ensure({ slug: f.slug, name: f.name, kind: 'fixed', sortOrder: sort++ });
        }
        await ensure({ slug: PO_ROOT.slug, name: PO_ROOT.name, kind: 'fixed', sortOrder: sort++ });
        // Cost codes sort after the fixed set, in code order.
        const sorted = costCodes
          .filter(c => c && c.code)
          .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
        for (const c of sorted) {
          const code  = String(c.code);
          const label = c.label ? `${code} · ${c.label}` : code;
          await ensure({ slug: `cc-${code}`, name: label, kind: 'cost_code', costCode: code, sortOrder: sort++ });
        }
      } else {
        let sort = 0;
        for (const f of GENERAL_FOLDERS) {
          await ensure({ slug: f.slug, name: f.name, kind: 'fixed', sortOrder: sort++ });
        }
      }

      if (created.length) {
        await audit(sql, {
          companyCode, division, projectId, action: 'FOLDER_CREATE', payload,
          detail: { generated: created.map(c => c.name) },
        });
      }

      const folders = await sql`
        SELECT * FROM project_folders
        WHERE  company_code = ${companyCode}
          AND  division     = ${division}
          AND  project_id IS NOT DISTINCT FROM ${projectId}
        ORDER  BY sort_order ASC, name ASC
      `;
      return res.json({ folders: folders.map(folderOut), created: created.length });
    }

    // ── POST ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};

      // Create one folder by hand.
      if (req.query.folder) {
        if (!caps.canUpload) {
          return res.status(403).json({ error: 'You do not have permission to create folders' });
        }
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Folder name is required' });
        if (name.length > 120) return res.status(400).json({ error: 'Folder name is too long' });

        const parentId = body.parentId ? String(body.parentId) : null;
        if (parentId) {
          const parent = await sql`
            SELECT id FROM project_folders
            WHERE id = ${parentId} AND company_code = ${companyCode} AND division = ${division}
          `;
          if (!parent.length) return res.status(404).json({ error: 'Parent folder not found' });
        }

        const id = newId();
        try {
          await sql`
            INSERT INTO project_folders
              (id, company_code, division, project_id, parent_id, name, kind, sort_order, created_by)
            VALUES
              (${id}, ${companyCode}, ${division}, ${projectId}, ${parentId}, ${name}, 'user', 900,
               ${payload.username || null})
          `;
        } catch (err) {
          if (isUniqueViolation(err)) {
            return res.status(409).json({ error: 'A folder with that name already exists here' });
          }
          throw err;
        }
        await audit(sql, { companyCode, division, projectId, folderId: id, action: 'FOLDER_CREATE', payload, detail: { name } });
        return res.status(201).json({ folder: { id, parent_id: parentId, name, kind: 'user', sort_order: 900 } });
      }

      // Register a file the browser has already uploaded to object storage.
      if (!caps.canUpload) {
        return res.status(403).json({ error: 'You do not have permission to upload' });
      }

      const id          = String(body.documentId || '').trim();
      const filename    = String(body.filename || '').trim();
      const storageKey  = String(body.storageKey || '').trim();
      const folderId    = body.folderId ? String(body.folderId) : null;
      const poId        = body.poId ? String(body.poId) : null;
      const sizeBytes   = parseInt(body.sizeBytes, 10) || 0;

      if (!id || !filename || !storageKey) {
        return res.status(400).json({ error: 'documentId, filename and storageKey are required' });
      }
      // A file must land somewhere. Filing is a required choice in the UI and
      // it is enforced here too, or a botched request orphans the upload.
      if (!folderId) return res.status(400).json({ error: 'A folder is required' });

      const contentType = storage.mimeFor(filename);
      if (!contentType) {
        return res.status(400).json({ error: `Files of that type cannot be uploaded. Allowed: ${storage.allowedExtensions().join(', ')}` });
      }
      if (sizeBytes > storage.maxUploadBytes()) {
        return res.status(413).json({ error: 'That file is larger than the upload limit' });
      }
      // The key is minted by api/document-upload-url.js and echoed back here.
      // Recompute it from the same inputs rather than sanity-checking the
      // string: a prefix test still admits a hand-crafted key like
      // 'FCT/turf/../../OTH/…', and object stores treat keys as opaque while
      // proxies in front of them may not. If it does not match byte for byte,
      // it did not come from us.
      const expectedKey = storage.buildKey({ companyCode, division, projectId, documentId: id, filename });
      if (storageKey !== expectedKey) {
        return res.status(400).json({ error: 'storageKey does not match this document' });
      }

      const folder = await sql`
        SELECT id FROM project_folders
        WHERE id = ${folderId} AND company_code = ${companyCode} AND division = ${division}
          AND project_id IS NOT DISTINCT FROM ${projectId}
      `;
      if (!folder.length) return res.status(404).json({ error: 'Folder not found' });

      try {
        await sql`
          INSERT INTO project_documents
            (id, company_code, division, project_id, filename, content_type, size_bytes,
             storage_key, note, uploaded_by)
          VALUES
            (${id}, ${companyCode}, ${division}, ${projectId}, ${filename}, ${contentType},
             ${sizeBytes}, ${storageKey}, ${body.note ? String(body.note).slice(0, 500) : null},
             ${payload.username || null})
        `;
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ error: 'That document is already registered' });
        throw err;
      }

      await sql`
        INSERT INTO document_links (document_id, company_code, link_type, target_id, created_by)
        VALUES (${id}, ${companyCode}, 'folder', ${folderId}, ${payload.username || null})
        ON CONFLICT DO NOTHING
      `;
      if (poId) {
        await sql`
          INSERT INTO document_links (document_id, company_code, link_type, target_id, created_by)
          VALUES (${id}, ${companyCode}, 'po', ${poId}, ${payload.username || null})
          ON CONFLICT DO NOTHING
        `;
      }

      await audit(sql, {
        companyCode, division, projectId, documentId: id, folderId,
        action: 'UPLOAD', payload,
        detail: { filename, size_bytes: sizeBytes, po_id: poId },
      });

      return res.status(201).json({
        document: {
          id, project_id: projectId, filename, content_type: contentType,
          size_bytes: sizeBytes, note: body.note || null,
          uploaded_by: payload.username || null, uploaded_at: new Date().toISOString(),
          folder_ids: [folderId], po_ids: poId ? [poId] : [],
        },
      });
    }

    // ── PATCH — rename, re-file, link, unlink, restore ───────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id is required' });
      const body = req.body || {};

      const rows = await sql`
        SELECT * FROM project_documents
        WHERE id = ${id} AND company_code = ${companyCode} AND division = ${division}
      `;
      if (!rows.length) return res.status(404).json({ error: 'Document not found' });
      const doc = rows[0];

      // level2 may tidy up their own uploads; level3 and admin may touch any.
      const isOwn = doc.uploaded_by && doc.uploaded_by === payload.username;
      if (!caps.canManage && !(caps.canUpload && isOwn)) {
        return res.status(403).json({ error: 'You can only change your own uploads' });
      }

      if (body.filename !== undefined) {
        const filename = String(body.filename).trim();
        if (!filename) return res.status(400).json({ error: 'Filename cannot be empty' });
        // Renaming must not smuggle a file out of the extension allowlist.
        if (storage.mimeFor(filename) !== doc.content_type) {
          return res.status(400).json({ error: 'A rename cannot change the file type' });
        }
        await sql`UPDATE project_documents SET filename = ${filename}, updated_at = NOW() WHERE id = ${id}`;
        await audit(sql, { companyCode, division, projectId: doc.project_id, documentId: id, action: 'RENAME', payload, detail: { from: doc.filename, to: filename } });
      }

      if (body.note !== undefined) {
        await sql`UPDATE project_documents SET note = ${String(body.note).slice(0, 500)}, updated_at = NOW() WHERE id = ${id}`;
      }

      if (body.restore) {
        if (!caps.canDelete) return res.status(403).json({ error: 'Only an administrator can restore a document' });
        await sql`UPDATE project_documents SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL WHERE id = ${id}`;
        await audit(sql, { companyCode, division, projectId: doc.project_id, documentId: id, action: 'RESTORE', payload });
      }

      // Link changes. addFolderId / addPoId file the document somewhere new;
      // the remove* pair only unfile it — destroying a file is DELETE.
      const links = [
        ['addFolderId',    'folder', true],
        ['addPoId',        'po',     true],
        ['removeFolderId', 'folder', false],
        ['removePoId',     'po',     false],
      ];
      for (const [field, linkType, adding] of links) {
        if (!body[field]) continue;
        const targetId = String(body[field]);

        if (adding && linkType === 'folder') {
          const f = await sql`
            SELECT id FROM project_folders
            WHERE id = ${targetId} AND company_code = ${companyCode} AND division = ${division}
              AND project_id IS NOT DISTINCT FROM ${doc.project_id}
          `;
          if (!f.length) return res.status(404).json({ error: 'Folder not found' });
        }

        if (adding) {
          await sql`
            INSERT INTO document_links (document_id, company_code, link_type, target_id, created_by)
            VALUES (${id}, ${companyCode}, ${linkType}, ${targetId}, ${payload.username || null})
            ON CONFLICT DO NOTHING
          `;
        } else {
          // Never leave a document unreachable. Unfiling its last folder would
          // strand it in the tree with no way back short of a SQL console.
          if (linkType === 'folder') {
            const remaining = await sql`
              SELECT COUNT(*)::int AS n FROM document_links
              WHERE document_id = ${id} AND link_type = 'folder' AND target_id <> ${targetId}
            `;
            if (!remaining[0].n) {
              return res.status(400).json({ error: 'A document must stay in at least one folder. Move it instead, or delete it.' });
            }
          }
          await sql`
            DELETE FROM document_links
            WHERE document_id = ${id} AND link_type = ${linkType} AND target_id = ${targetId}
          `;
        }

        await audit(sql, {
          companyCode, division, projectId: doc.project_id, documentId: id,
          action: adding ? 'LINK' : 'UNLINK', payload,
          detail: { link_type: linkType, target_id: targetId },
        });
      }

      const back = await sql`
          SELECT
          d.id, d.project_id, d.filename, d.content_type, d.size_bytes, d.note,
          d.uploaded_by, d.uploaded_at, d.deleted_at,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'folder'), '[]'::jsonb) AS folder_ids,
          COALESCE(jsonb_agg(DISTINCT l.target_id) FILTER (WHERE l.link_type = 'po'),     '[]'::jsonb) AS po_ids
        FROM   project_documents d
        LEFT   JOIN document_links l ON l.document_id = d.id
        WHERE  d.id = ${id}
        GROUP  BY d.id
      `;
      return res.json({ document: back.length ? documentOut(back[0]) : null });
    }

    // ── DELETE ───────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      // Empty user folders. Fixed and cost-code folders are generated, so
      // removing one only means it comes back on the next load.
      if (req.query.folderId) {
        if (!caps.canManage) return res.status(403).json({ error: 'You do not have permission to delete folders' });
        const folderId = String(req.query.folderId);

        const f = await sql`
          SELECT * FROM project_folders
          WHERE id = ${folderId} AND company_code = ${companyCode} AND division = ${division}
        `;
        if (!f.length) return res.status(404).json({ error: 'Folder not found' });
        if (f[0].kind !== 'user') {
          return res.status(400).json({ error: 'Standard and cost-code folders cannot be deleted' });
        }

        const held = await sql`
          SELECT COUNT(*)::int AS n FROM document_links l
          JOIN project_documents d ON d.id = l.document_id AND d.deleted_at IS NULL
          WHERE l.link_type = 'folder' AND l.target_id = ${folderId}
        `;
        if (held[0].n) return res.status(400).json({ error: 'That folder still holds documents' });

        const kids = await sql`SELECT COUNT(*)::int AS n FROM project_folders WHERE parent_id = ${folderId}`;
        if (kids[0].n) return res.status(400).json({ error: 'That folder still holds subfolders' });

        await sql`DELETE FROM project_folders WHERE id = ${folderId}`;
        await audit(sql, { companyCode, division, projectId, folderId, action: 'FOLDER_DELETE', payload, detail: { name: f[0].name } });
        return res.json({ ok: true });
      }

      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id is required' });
      if (!caps.canDelete) {
        return res.status(403).json({ error: 'Only an administrator can delete a document' });
      }

      const rows = await sql`
        SELECT * FROM project_documents
        WHERE id = ${id} AND company_code = ${companyCode} AND division = ${division}
      `;
      if (!rows.length) return res.status(404).json({ error: 'Document not found' });

      // Soft delete. The stored object survives until the purge sweep, so a
      // contract deleted by mistake is recoverable for 30 days.
      await sql`
        UPDATE project_documents
        SET    deleted_at  = NOW(),
               deleted_by  = ${payload.username || null},
               purge_after = NOW() + make_interval(days => ${TRASH_WINDOW_DAYS})
        WHERE  id = ${id}
      `;
      await audit(sql, {
        companyCode, division, projectId: rows[0].project_id, documentId: id,
        action: 'DELETE', payload,
        detail: { filename: rows[0].filename, recoverable_days: TRASH_WINDOW_DAYS },
      });
      return res.json({ ok: true, recoverableDays: TRASH_WINDOW_DAYS });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[documents]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

module.exports.FIXED_FOLDERS   = FIXED_FOLDERS;
module.exports.GENERAL_FOLDERS = GENERAL_FOLDERS;
module.exports.PO_ROOT         = PO_ROOT;
module.exports._capabilities   = capabilities;
