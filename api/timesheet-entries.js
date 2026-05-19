'use strict';
/**
 * Timesheet entries — field-employee time submissions.
 *
 *   GET    /api/timesheet-entries                       — list entries
 *     Field user  → only their own rows
 *     Payroll admin → all company rows (filter via query params)
 *     Query: ?status=draft|submitted|approved
 *            ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *            ?user_id=N      (admin only)
 *            ?division=X     (admin only — filter by which division was worked)
 *
 *   POST   /api/timesheet-entries                       — create draft
 *     Body matches entry shape; status forced to 'draft'.
 *     Field-user only (requires divisionRoles.timesheet access).
 *
 *   PUT    /api/timesheet-entries?id=N                  — update entry
 *     Field user  → own row, only if status='draft'
 *     Payroll admin → any row with status='submitted' (logs as ADMIN_EDIT)
 *
 *   POST   /api/timesheet-entries?action=submit&id=N    — draft → submitted
 *     Field-user only, must own the row, row must be in 'draft'.
 *
 *   POST   /api/timesheet-entries?action=approve&id=N   — submitted → approved
 *     Payroll-admin only, row must be in 'submitted'.
 *
 *   DELETE /api/timesheet-entries?id=N                  — delete own draft
 *     Field-user only, must own the row, row must be in 'draft'.
 *
 * The server is the source of truth for:
 *   - status transitions (clients cannot set status directly)
 *   - computed_hours (recomputed from start_time/end_time on every write)
 *   - user_id / username / company_code (taken from JWT, never the body)
 *
 * This data is intentionally isolated from daily_tracking.labor_hours and
 * dust_control_entries — payroll uses timesheet_entries only.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const VALID_DIVISIONS = ['turf', 'dust', 'paving', 'trucking', 'quarry'];
const VALID_TIME_OFF  = ['vacation', 'sick', 'jury_duty', 'bereavement', 'holiday'];

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

/**
 * Compute decimal hours between two "HH:MM" strings, handling overnight.
 * Returns null if either side is missing/invalid. Caps at 24h.
 */
function computeHours(start, end) {
  const s = safeTime(start);
  const e = safeTime(end);
  if (!s || !e) return null;
  const [sh, sm] = s.split(':').map(Number);
  const [eh, em] = e.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // overnight shift
  if (mins > 24 * 60) mins = 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
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

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function dbToEntry(r) {
  return {
    id:                  String(r.id),
    user_id:             r.user_id,
    username:            r.username,
    employee_id:         r.employee_id,
    entry_type:          r.entry_type,
    work_date:           safeDate(r.work_date) || '',
    status:              r.status,
    division:            r.division || '',
    job_id:              r.job_id || '',
    job_label:           r.job_label || '',
    start_time:          r.start_time || '',
    end_time:            r.end_time || '',
    computed_hours:      r.computed_hours != null ? Number(r.computed_hours) : null,
    lunch_break:         r.lunch_break,
    operated_equipment:  r.operated_equipment,
    supervisor_id:       r.supervisor_id,
    supervisor_name:     r.supervisor_name || '',
    notes:               r.notes || '',
    time_off_type:       r.time_off_type || '',
    submitted_at:        r.submitted_at,
    approved_at:         r.approved_at,
    approved_by_user_id: r.approved_by_user_id,
    approved_by_name:    r.approved_by_name || '',
    created_at:          r.created_at,
    updated_at:          r.updated_at,
  };
}

async function writeAudit(sql, companyCode, payload, entryId, action, changes, snapshot) {
  try {
    await sql`
      INSERT INTO timesheet_audit_log
        (company_code, entry_id, action, user_id, username, changes, snapshot)
      VALUES
        (${companyCode}, ${entryId}, ${action},
         ${payload?.userId || null}, ${payload?.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb)
    `;
  } catch (err) {
    console.error('[timesheet-entries] audit write failed (non-fatal):', err.message);
  }
}

function normalizeEntryBody(body) {
  const entry_type = body.entry_type === 'time_off' ? 'time_off' : 'daily';

  const work_date = safeDate(body.work_date);
  if (!work_date) return { error: 'work_date (YYYY-MM-DD) is required' };

  if (entry_type === 'time_off') {
    const time_off_type = VALID_TIME_OFF.includes(body.time_off_type) ? body.time_off_type : null;
    if (!time_off_type) return { error: 'time_off_type is required (vacation, sick, jury_duty, bereavement, holiday)' };
    return {
      data: {
        entry_type,
        work_date,
        division:           null,
        job_id:             null,
        job_label:          null,
        start_time:         null,
        end_time:           null,
        computed_hours:     null,
        lunch_break:        null,
        operated_equipment: null,
        supervisor_id:      null,
        supervisor_name:    null,
        notes:              safeStr(body.notes, 2000),
        time_off_type,
      },
    };
  }

  // Daily entry
  const division = VALID_DIVISIONS.includes(body.division) ? body.division : null;
  if (!division) return { error: 'division must be one of: ' + VALID_DIVISIONS.join(', ') };

  const job_id    = safeStr(body.job_id, 200);
  const job_label = safeStr(body.job_label, 500);
  if (!job_id || !job_label) return { error: 'job_id and job_label are required for a daily entry' };

  const start_time = safeTime(body.start_time);
  const end_time   = safeTime(body.end_time);
  if (!start_time || !end_time) return { error: 'start_time and end_time (HH:MM) are required' };

  const lunch_break = safeBool(body.lunch_break);

  // Lunch deduction: when the worker checked "Yes" for lunch, subtract a
  // 30-minute unpaid break from the gross start→end span. Clamp at 0 so a
  // sub-30-minute span with lunch=yes doesn't produce a negative.
  let computed_hours = computeHours(start_time, end_time);
  if (computed_hours == null || computed_hours <= 0) {
    return { error: 'start_time/end_time produced 0 hours — check the values' };
  }
  if (lunch_break === true) {
    computed_hours = Math.max(0, Math.round((computed_hours - 0.5) * 100) / 100);
  }

  const supervisor_id   = safeInt(body.supervisor_id);
  const supervisor_name = safeStr(body.supervisor_name, 200);
  if (!supervisor_name) return { error: 'supervisor_name is required' };

  return {
    data: {
      entry_type,
      work_date,
      division,
      job_id,
      job_label,
      start_time,
      end_time,
      computed_hours,
      lunch_break,
      operated_equipment: safeBool(body.operated_equipment),
      supervisor_id,
      supervisor_name,
      notes:              safeStr(body.notes, 2000),
      time_off_type:      null,
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId, username } = payload;
  const canSubmit  = hasDivisionAccess(payload, 'timesheet');
  const canAdmin   = hasDivisionAccess(payload, 'payroll') || payload.isPlatformAdmin;

  if (!canSubmit && !canAdmin) {
    return res.status(403).json({ error: 'You do not have access to Timesheet or Payroll' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const q = req.query || {};
      // Status filter accepts a single value, the combined sentinel
      // "submitted_approved" (payroll's default view), or '' for all.
      let statusList;
      if (q.status === 'submitted_approved')              statusList = ['submitted', 'approved'];
      else if (['draft','submitted','approved'].includes(q.status)) statusList = [q.status];
      else                                                statusList = []; // match all

      const fromF = safeDate(q.from) || '1900-01-01';
      const toF   = safeDate(q.to)   || '9999-12-31';
      const userF = canAdmin ? safeInt(q.user_id) : userId;
      const divF  = canAdmin && VALID_DIVISIONS.includes(q.division) ? q.division : '';

      // Empty array sentinel — Postgres treats array_length(empty,1) as NULL,
      // so we pass a marker that's never a real status to express "no filter".
      const statusFilter = statusList.length ? statusList : ['__all__'];

      let rows;
      if (userF != null) {
        rows = await sql`
          SELECT * FROM timesheet_entries
          WHERE company_code = ${companyCode}
            AND user_id      = ${userF}
            AND ('__all__' = ANY(${statusFilter}) OR status = ANY(${statusFilter}))
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${divF} = '' OR division = ${divF})
          ORDER BY work_date DESC, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT * FROM timesheet_entries
          WHERE company_code = ${companyCode}
            AND ('__all__' = ANY(${statusFilter}) OR status = ANY(${statusFilter}))
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${divF} = '' OR division = ${divF})
          ORDER BY work_date DESC, created_at DESC
        `;
      }

      return res.json({ entries: rows.map(dbToEntry) });
    }

    // ── POST (create draft) — field-user only ─────────────────────────────
    if (req.method === 'POST' && !req.query.action) {
      if (!canSubmit) {
        return res.status(403).json({ error: 'Timesheet access is required to create entries' });
      }

      const { data, error } = normalizeEntryBody(req.body || {});
      if (error) return res.status(400).json({ error });

      const inserted = await sql`
        INSERT INTO timesheet_entries (
          company_code, user_id, username, entry_type, work_date, status,
          division, job_id, job_label,
          start_time, end_time, computed_hours,
          lunch_break, operated_equipment,
          supervisor_id, supervisor_name,
          notes, time_off_type
        ) VALUES (
          ${companyCode}, ${userId}, ${username}, ${data.entry_type}, ${data.work_date}, 'draft',
          ${data.division}, ${data.job_id}, ${data.job_label},
          ${data.start_time}, ${data.end_time}, ${data.computed_hours},
          ${data.lunch_break}, ${data.operated_equipment},
          ${data.supervisor_id}, ${data.supervisor_name},
          ${data.notes}, ${data.time_off_type}
        )
        RETURNING *
      `;
      const row = inserted[0];
      await writeAudit(sql, companyCode, payload, row.id, 'INSERT', null, dbToEntry(row));
      return res.json({ ok: true, entry: dbToEntry(row) });
    }

    // ── POST ?action=submit — draft → submitted (field-user, own row) ─────
    if (req.method === 'POST' && req.query.action === 'submit') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.user_id !== userId) {
        return res.status(403).json({ error: 'You can only submit your own entries' });
      }
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: `Cannot submit an entry that is already ${existing.status}` });
      }
      if (!canSubmit) {
        return res.status(403).json({ error: 'Timesheet access is required' });
      }

      const [updated] = await sql`
        UPDATE timesheet_entries
        SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(sql, companyCode, payload, id, 'SUBMIT', null, dbToEntry(updated));
      return res.json({ ok: true, entry: dbToEntry(updated) });
    }

    // ── POST ?action=approve — submitted → approved (payroll admin) ───────
    if (req.method === 'POST' && req.query.action === 'approve') {
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.status !== 'submitted') {
        return res.status(409).json({ error: `Cannot approve an entry that is ${existing.status}` });
      }

      const [updated] = await sql`
        UPDATE timesheet_entries
        SET status              = 'approved',
            approved_at         = NOW(),
            approved_by_user_id = ${userId},
            approved_by_name    = ${username},
            updated_at          = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(sql, companyCode, payload, id, 'APPROVE', null, dbToEntry(updated));
      return res.json({ ok: true, entry: dbToEntry(updated) });
    }

    // ── PUT — update fields ───────────────────────────────────────────────
    if (req.method === 'PUT') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      const isOwnDraft      = existing.user_id === userId && existing.status === 'draft';
      // Payroll admins may correct mistakes on both submitted AND approved
      // entries — the audit log records the prior snapshot either way.
      const isAdminEditable = canAdmin && (existing.status === 'submitted' || existing.status === 'approved');
      if (!isOwnDraft && !isAdminEditable) {
        return res.status(403).json({ error: 'This entry cannot be edited from your account' });
      }

      const { data, error } = normalizeEntryBody(req.body || {});
      if (error) return res.status(400).json({ error });

      const [updated] = await sql`
        UPDATE timesheet_entries SET
          entry_type         = ${data.entry_type},
          work_date          = ${data.work_date},
          division           = ${data.division},
          job_id             = ${data.job_id},
          job_label          = ${data.job_label},
          start_time         = ${data.start_time},
          end_time           = ${data.end_time},
          computed_hours     = ${data.computed_hours},
          lunch_break        = ${data.lunch_break},
          operated_equipment = ${data.operated_equipment},
          supervisor_id      = ${data.supervisor_id},
          supervisor_name    = ${data.supervisor_name},
          notes              = ${data.notes},
          time_off_type      = ${data.time_off_type},
          updated_at         = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(
        sql, companyCode, payload, id,
        isAdminEditable ? 'ADMIN_EDIT' : 'UPDATE',
        null, dbToEntry(updated)
      );
      return res.json({ ok: true, entry: dbToEntry(updated) });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    // Field user: their OWN drafts only.
    // Payroll admin: any entry regardless of status (recorded as DELETE in
    // the audit log with the full pre-delete snapshot).
    if (req.method === 'DELETE') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      const isOwnDraft = existing.user_id === userId && existing.status === 'draft';
      if (!isOwnDraft && !canAdmin) {
        return res.status(403).json({ error: 'You do not have permission to delete this entry' });
      }

      await sql`DELETE FROM timesheet_entries WHERE id = ${id} AND company_code = ${companyCode}`;
      await writeAudit(sql, companyCode, payload, id, 'DELETE', null, dbToEntry(existing));
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[timesheet-entries]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
