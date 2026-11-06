'use strict';

// POST /api/email/send-report
//
// Sends a report to one or more recipients via Resend.
// Auth-gated to any logged-in user with access to the report's source
// division. The caller supplies the rendered HTML (the same HTML the
// existing print/PDF flow produces); the server sanitizes it, renders it
// to a PDF through headless Chrome, and sends a short summary email with
// that PDF attached.
//
// Attaching rather than inlining is the point: these reports are wide
// landscape tables built with <style> blocks and @page rules, and email
// clients honor neither — inlined, they arrive clipped and ragged. The PDF
// is what the sender would have gotten from Print → Save as PDF, and it
// reads the same on every client and screen size.
//
// If the renderer is unavailable the send still goes out with the report
// inlined the old way, and the response carries a `warning` the caller
// surfaces — a broken renderer degrades the email instead of dropping it.
//
// Body:
//   {
//     report_type:  'executive' | 'turf_daily_pm' | 'turf_daily_summary' | 'paving_daily_pm',
//     project_id?:  string,        // for project-scoped reports (PM reports)
//     project_name?:string,        // displayed in email title
//     recipients:   string[],      // 1..MAX_RECIPIENTS emails
//     subject:      string,        // email subject
//     note?:        string,        // optional caller note prepended above the report
//     html:         string,        // report body HTML (inline-styled is best)
//     attach_pdf?:  boolean,       // default true — render `html` to an attached PDF
//     summary?:     [{ label, value, tone? }]  // key figures shown in the email body
//                                              // tone: 'good' | 'bad' | 'actual'
//
//     custom_report?: { report_id?, report_name?, project_ids?, project_names?,
//                       date_from?, date_to?, included_internal?, definition?,
//                       run_kind?: 'user' | 'resend', resent_from_run_id? }
//                                  // a *_custom_report send: what to put in the
//                                  // Custom Reporting send history
//   }
//
// Response:
//   { ok: true, id, recipientCount, pdfAttached, subject, pdfPages?, warning?,
//     logged?, run_id?, archived? }
//   | { ok: false, error: '...' }
//
// subject is the one the email actually went out with (an empty one becomes
// the report's label). For a *_custom_report type the send is written to
// custom_report_runs here, once the email has gone — the history that
// answers "what did we send the owner, and did it have our costs on it?" — and
// logged says whether that worked, so the browser logs it only when it did not.
// included_internal is true when the caller says so, when the definition it
// sent has internal data switched on, or when the HTML carries the engine's
// data-cr-internal mark: whichever way, an email with our costs on it is
// never recorded as customer-safe.
//
// A logged custom-report email also keeps the HTML it delivered — the
// sanitized document, the same string the send went out with — in
// custom_report_run_archives, so Customer History can open exactly what the
// owner was sent. archived says whether that worked; like the log, a failure
// never fails the send.
//
// The company name in the email's header is read fresh on every send — the
// company's branding display name, else its name — rather than taken from the
// sign-in token, which can be a month old. The token's copy is the fallback
// when the database cannot say.

const { requireAuth, levelFor, isSalesIn } = require('../lib/auth');
const {
  MAX_RECIPIENTS,
  MAX_HTML_BYTES,
  isValidEmail,
  normalizeAttachments,
  sanitizeReportHtml,
} = require('../lib/email');
const { deliverReport } = require('../lib/report-delivery');
const { inlineCidImages } = require('../lib/pdf');
// Each report type → which division the caller must have access to. Shared
// with the scheduled sends, which check the same thing for the account a
// schedule runs as.
const { REPORT_TYPES, mayUseDivision } = require('../lib/report-catalog');
const { neon } = require('@neondatabase/serverless');
const {
  readRun, insertRun, insertArchive, pruneArchives, isPlainObject, INTERNAL_MARK,
} = require('../lib/custom-report-runs');

/**
 * The name the email's header carries: the company's branding display name,
 * else companies.name, read now. Falls back to the sign-in token's copy when
 * there is no database to ask, no such company, or the query fails — never
 * worth failing or delaying a send over.
 */
async function freshCompanyName(payload) {
  const fallback = payload && payload.companyName;
  if (!payload || !payload.companyCode || !process.env.DATABASE_URL) return fallback;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT COALESCE(NULLIF(btrim(b.display_name), ''), c.name) AS name
        FROM companies c
        LEFT JOIN company_branding b ON b.company_code = c.code AND b.division = ''
       WHERE c.code = ${payload.companyCode}`;
    const name = rows[0] && typeof rows[0].name === 'string' ? rows[0].name.trim() : '';
    return name || fallback;
  } catch (err) {
    console.error('[email/send-report] company name not read, using the sign-in copy:', err.message);
    return fallback;
  }
}

/**
 * Record an emailed custom report in its division's send history, and keep
 * the HTML it delivered. Never throws and never fails the send — the email
 * has already gone; on a failure the caller is told (logged: false,
 * archived: false) so the browser can log it instead.
 */
async function logCustomReportSend({ payload, division, body, html, attachments, recipients, subject, label }) {
  const userId = Number(payload.userId);
  if (!Number.isSafeInteger(userId) || !payload.companyCode) return { logged: false, archived: false };
  const cr = isPlainObject(body.custom_report) ? body.custom_report : {};
  const internal = cr.included_internal === true || INTERNAL_MARK.test(html);
  const base = {
    action: 'email', recipients, subject, included_internal: internal,
    run_kind: cr.run_kind, resent_from_run_id: cr.resent_from_run_id,
  };
  const described = {
    report_id: cr.report_id, report_name: cr.report_name || label, project_ids: cr.project_ids,
    project_names: cr.project_names, date_from: cr.date_from, date_to: cr.date_to, definition: cr.definition,
  };
  let r = readRun({ ...described, ...base });
  // Something in the browser's description would not store (too many jobs, a
  // bad date): log the email anyway, without it, rather than not at all.
  if (r.error) r = readRun({ report_name: described.report_name, ...base });
  if (r.error) return { logged: false, archived: false };
  let sql, run;
  try {
    sql = neon(process.env.DATABASE_URL);
    const level = levelFor(payload, division);
    run = await insertRun(sql, {
      company: payload.companyCode, division, me: { userId, username: payload.username || null }, run: r.value,
      canShare: level === 'admin' || level === 'level3', sales: isSalesIn(payload, division),
    });
  } catch (err) {
    console.error('[email/send-report] custom report history not written:', err.message,
      'user=' + payload.username, 'company=' + payload.companyCode);
    return { logged: false, archived: false };
  }
  // What went out is what deliverReport sanitized: the same function run on
  // the same string gives the same document. Any cid: image is put inline the
  // way the PDF has it, so the archive opens on its own, later, anywhere.
  let archived = false;
  try {
    const kept = inlineCidImages(sanitizeReportHtml(html), attachments || []);
    archived = await insertArchive(sql, { runId: run.id, company: payload.companyCode, html: kept });
  } catch (err) {
    console.error('[email/send-report] custom report archive not written:', err.message,
      'run=' + run.id, 'company=' + payload.companyCode);
  }
  if (archived) {
    try { await pruneArchives(sql, payload.companyCode); }
    catch (err) { console.error('[email/send-report] archive prune failed:', err.message); }
  }
  return { logged: true, runId: run.id, archived };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;

  const body = req.body || {};
  const {
    report_type,
    project_name,
    recipients,
    subject,
    note,
    html,
    attachments,
    summary,
  } = body;
  const attachPdf = body.attach_pdf !== false;

  // Validate report type + division access.
  const cfg = REPORT_TYPES[report_type];
  if (!cfg) return res.status(400).json({ ok: false, error: 'Unknown report_type' });
  // The line Auto Reports draws, not bare division access: Safety crew and
  // payroll coders hold their division without being allowed its reports.
  if (!mayUseDivision(payload, cfg.division)) {
    return res.status(403).json({ ok: false, error: 'You do not have access to send this report' });
  }

  // Validate recipients.
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ ok: false, error: 'At least one recipient is required' });
  }
  const cleaned = [];
  const seen = new Set();
  for (const raw of recipients) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    if (!isValidEmail(e)) {
      return res.status(400).json({ ok: false, error: `Invalid email: ${raw}` });
    }
    seen.add(e);
    cleaned.push(e);
    if (cleaned.length > MAX_RECIPIENTS) {
      return res.status(400).json({ ok: false, error: `Too many recipients (max ${MAX_RECIPIENTS})` });
    }
  }
  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid recipients' });
  }

  // Validate body.
  if (typeof html !== 'string' || html.length === 0) {
    return res.status(400).json({ ok: false, error: 'Report body is required' });
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(413).json({ ok: false, error: 'Report HTML is too large' });
  }

  // Validate optional inline attachments (e.g. the rendered Gantt PNG).
  const att = normalizeAttachments(attachments);
  if (!att.ok) {
    return res.status(400).json({ ok: false, error: att.error });
  }

  const companyName = await freshCompanyName(payload);

  const sent = await deliverReport({
    label:        cfg.label,
    projectName:  project_name,
    recipients:   cleaned,
    subject,
    note,
    html,
    attachments:  att.attachments,
    summary,
    attachPdf,
    companyName,
    logTag:       'user=' + payload.username + ' report=' + report_type,
  });

  if (!sent.ok) {
    if (sent.status === 502) {
      console.error('[email/send-report] failed:',
        sent.error,
        'user=' + payload.username,
        'company=' + payload.companyCode,
        'report=' + report_type
      );
    }
    return res.status(sent.status || 502).json({ ok: false, error: sent.error || 'Email send failed' });
  }

  console.log('[email/send-report] sent',
    'id=' + sent.id,
    'user=' + payload.username,
    'company=' + payload.companyCode,
    'report=' + report_type,
    'recipients=' + cleaned.length,
    'pdf=' + (sent.pdfAttached ? (sent.pdfPages ? sent.pdfPages + 'p' : 'yes') : 'no')
  );

  let history = null;
  if (/_custom_report$/.test(report_type)) {
    history = await logCustomReportSend({
      payload, division: cfg.division, body, html, attachments: att.attachments, recipients: cleaned,
      subject: sent.subject, label: cfg.label,
    });
  }

  return res.json({
    ok:             true,
    id:             sent.id,
    recipientCount: cleaned.length,
    pdfAttached:    sent.pdfAttached,
    // What it really went out as: an empty subject becomes the label, and
    // the browser records this, not what was typed.
    subject:        sent.subject,
    ...(sent.pdfPages ? { pdfPages: sent.pdfPages } : {}),
    ...(sent.warning ? { warning: sent.warning } : {}),
    ...(history ? {
      logged: history.logged,
      ...(history.runId ? { run_id: history.runId } : {}),
      archived: history.archived === true,
    } : {}),
  });
};
