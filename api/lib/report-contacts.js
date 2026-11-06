'use strict';

// Saved customer contacts for Custom Reporting (report_contacts) — the people a
// job's reports go to. Shared by:
//
//   api/report-contacts.js              the CRUD the Email modal and the
//                                       Contacts manager use
//   api/lib/report-schedule-runner.js   a schedule that sends to "each job's
//                                       saved contacts" (use_job_contacts)
//
// A contact belongs to one job (project_id) or to every job of one client
// (client_key). The key is the client name as the job carries it, trimmed and
// lower-cased, so "Acme Township" and " acme township " are one client — the
// same comparison the builder makes when it warns that picked jobs belong to
// different clients.

const DIVISIONS = ['turf', 'paving', 'kiewit'];

/** The key a client-level contact is filed under, or '' for no client. */
function clientKeyOf(client) {
  if (typeof client !== 'string' && typeof client !== 'number') return '';
  return String(client).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().toLowerCase();
}

/**
 * The saved contacts a send to these jobs should go to: every live contact
 * marked auto_add on one of the jobs, then on one of their clients, once per
 * address (compared without case) — the job's own entry wins over the
 * client's, so the name it carries is the one the job knows.
 *
 *   contactsForJobs(sql, company, division, [{ id, client }])
 *     → [{ email, name, source: 'job' | 'client' }]
 *
 * Addresses are returned as stored (they were checked when saved); the caller
 * still validates before sending, as it does every address.
 */
async function contactsForJobs(sql, company, division, projects) {
  if (!company || !DIVISIONS.includes(division) || !Array.isArray(projects) || !projects.length) return [];
  const ids = new Set();
  const keys = new Set();
  for (const p of projects) {
    if (!p || typeof p !== 'object') continue;
    if (p.id !== undefined && p.id !== null && String(p.id).trim()) ids.add(String(p.id).trim());
    const k = clientKeyOf(p.client);
    if (k) keys.add(k);
  }
  if (!ids.size && !keys.size) return [];
  const rows = await sql`
    SELECT email, name, project_id, client_key
      FROM report_contacts
     WHERE company_code = ${company} AND division = ${division}
       AND deleted_at IS NULL AND auto_add
       AND (project_id = ANY(${[...ids]}::text[])
            OR (project_id IS NULL AND client_key = ANY(${[...keys]}::text[])))
     ORDER BY (project_id IS NULL), id`;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: r.name || null, source: r.project_id ? 'job' : 'client' });
  }
  return out;
}

module.exports = { DIVISIONS, clientKeyOf, contactsForJobs };
