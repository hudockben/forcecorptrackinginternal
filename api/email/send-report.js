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
//   }
//
// Response:
//   { ok: true, id, recipientCount, pdfAttached, pdfPages?, warning? }
//   | { ok: false, error: '...' }

const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const {
  MAX_RECIPIENTS,
  MAX_HTML_BYTES,
  isValidEmail,
  normalizeAttachments,
} = require('../lib/email');
const { deliverReport } = require('../lib/report-delivery');
// Each report type → which division the caller must have access to. Shared
// with the scheduled sends, which check the same thing for the account a
// schedule runs as.
const { REPORT_TYPES } = require('../lib/report-catalog');

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
  if (!hasDivisionAccess(payload, cfg.division)) {
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
    companyName:  payload.companyName,
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

  return res.json({
    ok:             true,
    id:             sent.id,
    recipientCount: cleaned.length,
    pdfAttached:    sent.pdfAttached,
    ...(sent.pdfPages ? { pdfPages: sent.pdfPages } : {}),
    ...(sent.warning ? { warning: sent.warning } : {}),
  });
};
