'use strict';

// /api/email/recipient-groups
//
// CRUD for saved email distribution groups (used by the "Email Report"
// modal on the executive / turf / paving reports). All groups are scoped
// to the caller's company.
//
// GET    /api/email/recipient-groups
//          ?report_type=<type>&project_id=<id>
//        Returns groups visible to the caller, with project-tied groups
//        for the given project_id listed first. Filtering by report_type
//        is best-effort: groups created with report_type=null are always
//        included (general groups).
//
// POST   /api/email/recipient-groups         (admin only)
//        { name, emails[], project_id?, report_type? }
//
// PUT    /api/email/recipient-groups?id=<n>  (admin only)
//        { name?, emails?[], project_id?, report_type? }
//
// DELETE /api/email/recipient-groups?id=<n>  (admin only)

const { neon }                = require('@neondatabase/serverless');
const { requireAuth }         = require('../lib/auth');
const { isValidEmail }        = require('../lib/email');

const VALID_REPORT_TYPES = new Set([
  'executive',
  'turf_daily_pm', 'turf_daily_summary',
  'paving_daily_pm', 'paving_daily_summary',
  'quarry_breakeven',
  'dust_tracking_summary',
]);
const MAX_NAME_LEN     = 120;
const MAX_EMAILS       = 50;

function isAdmin(payload) {
  if (!payload) return false;
  if (payload.isPlatformAdmin) return true;
  if (payload.role === 'admin') return true;
  // A user is also considered an admin if any of their division roles is 'admin'.
  const dr = payload.divisionRoles;
  if (dr && typeof dr === 'object') {
    for (const v of Object.values(dr)) if (v === 'admin') return true;
  }
  return false;
}

function normalizeEmails(input) {
  if (!Array.isArray(input)) return { error: 'emails must be an array' };
  const seen = new Set();
  const out  = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    if (!isValidEmail(e)) return { error: `Invalid email: ${raw}` };
    seen.add(e);
    out.push(e);
    if (out.length > MAX_EMAILS) return { error: `Too many emails (max ${MAX_EMAILS})` };
  }
  if (out.length === 0) return { error: 'At least one email is required' };
  return { emails: out };
}

function normalizeReportType(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase();
  return VALID_REPORT_TYPES.has(s) ? s : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const sql = neon(process.env.DATABASE_URL);
  const company = payload.companyCode;

  try {
    // ── GET ─────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rt = normalizeReportType(req.query?.report_type);
      const pid = (req.query?.project_id && String(req.query.project_id).trim()) || null;

      // Pull all company groups; filter and order in JS for clarity.
      const rows = await sql`
        SELECT id, name, emails, project_id, report_type,
               created_by, created_by_username, created_at, updated_at
          FROM report_recipient_groups
         WHERE company_code = ${company}
      `;

      const filtered = rows.filter(r => {
        if (rt && r.report_type && r.report_type !== rt) return false;
        return true;
      });

      // Sort: groups matching the current project first, then by name.
      filtered.sort((a, b) => {
        const aMatch = pid && a.project_id === pid ? 1 : 0;
        const bMatch = pid && b.project_id === pid ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

      return res.json({
        ok:     true,
        groups: filtered.map(r => ({
          id:                  Number(r.id),
          name:                r.name,
          emails:              Array.isArray(r.emails) ? r.emails : [],
          project_id:          r.project_id,
          report_type:         r.report_type,
          created_by:          r.created_by,
          created_by_username: r.created_by_username,
          created_at:          r.created_at,
          updated_at:          r.updated_at,
        })),
        isAdmin: isAdmin(payload),
      });
    }

    // ── POST (admin only) ───────────────────────────────────────────────
    if (req.method === 'POST') {
      if (!isAdmin(payload)) return res.status(403).json({ ok: false, error: 'Admin access required' });

      const { name, emails, project_id, report_type } = req.body || {};
      const trimmedName = (typeof name === 'string' && name.trim().slice(0, MAX_NAME_LEN)) || '';
      if (!trimmedName) return res.status(400).json({ ok: false, error: 'name is required' });

      const norm = normalizeEmails(emails);
      if (norm.error) return res.status(400).json({ ok: false, error: norm.error });

      const pid = (typeof project_id === 'string' && project_id.trim()) || null;
      const rt  = normalizeReportType(report_type);

      const inserted = await sql`
        INSERT INTO report_recipient_groups
          (company_code, name, emails, project_id, report_type, created_by, created_by_username)
        VALUES
          (${company}, ${trimmedName}, ${JSON.stringify(norm.emails)}::jsonb, ${pid}, ${rt},
           ${payload.userId || null}, ${payload.username || null})
        RETURNING id, name, emails, project_id, report_type, created_by, created_by_username, created_at, updated_at
      `;
      const r = inserted[0];
      return res.json({
        ok: true,
        group: {
          id:                  Number(r.id),
          name:                r.name,
          emails:              r.emails,
          project_id:          r.project_id,
          report_type:         r.report_type,
          created_by:          r.created_by,
          created_by_username: r.created_by_username,
          created_at:          r.created_at,
          updated_at:          r.updated_at,
        },
      });
    }

    // ── PUT (admin only) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!isAdmin(payload)) return res.status(403).json({ ok: false, error: 'Admin access required' });

      const id = parseInt(req.query?.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id is required' });

      // Load existing row (and check ownership) — we merge in JS to avoid
      // conditional SQL.
      const existing = await sql`
        SELECT id, name, emails, project_id, report_type
          FROM report_recipient_groups
         WHERE id = ${id} AND company_code = ${company}
      `;
      if (!existing.length) return res.status(404).json({ ok: false, error: 'Group not found' });
      const cur = existing[0];

      const { name, emails, project_id, report_type } = req.body || {};

      let nextName = cur.name;
      if (name !== undefined) {
        const t = String(name || '').trim().slice(0, MAX_NAME_LEN);
        if (!t) return res.status(400).json({ ok: false, error: 'name cannot be empty' });
        nextName = t;
      }

      let nextEmails = Array.isArray(cur.emails) ? cur.emails : [];
      if (emails !== undefined) {
        const norm = normalizeEmails(emails);
        if (norm.error) return res.status(400).json({ ok: false, error: norm.error });
        nextEmails = norm.emails;
      }

      const nextPid = project_id === undefined
        ? cur.project_id
        : ((typeof project_id === 'string' && project_id.trim()) || null);
      const nextRt = report_type === undefined ? cur.report_type : normalizeReportType(report_type);

      const updated = await sql`
        UPDATE report_recipient_groups SET
          name        = ${nextName},
          emails      = ${JSON.stringify(nextEmails)}::jsonb,
          project_id  = ${nextPid},
          report_type = ${nextRt},
          updated_at  = NOW()
         WHERE id = ${id} AND company_code = ${company}
         RETURNING id, name, emails, project_id, report_type, created_by, created_by_username, created_at, updated_at
      `;
      const r = updated[0];
      return res.json({
        ok: true,
        group: {
          id:                  Number(r.id),
          name:                r.name,
          emails:              r.emails,
          project_id:          r.project_id,
          report_type:         r.report_type,
          created_by:          r.created_by,
          created_by_username: r.created_by_username,
          created_at:          r.created_at,
          updated_at:          r.updated_at,
        },
      });
    }

    // ── DELETE (admin only) ─────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!isAdmin(payload)) return res.status(403).json({ ok: false, error: 'Admin access required' });

      const id = parseInt(req.query?.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id is required' });

      await sql`
        DELETE FROM report_recipient_groups
         WHERE id = ${id} AND company_code = ${company}
      `;
      return res.json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[email/recipient-groups]', err.message);
    return res.status(500).json({ ok: false, error: 'Database error', detail: err.message });
  }
};
