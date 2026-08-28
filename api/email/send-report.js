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
//     summary?:     [{ label, value }]  // key figures shown in the email body
//   }
//
// Response:
//   { ok: true, id, recipientCount, pdfAttached, pdfPages?, warning? }
//   | { ok: false, error: '...' }

const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const {
  MAX_RECIPIENTS,
  MAX_HTML_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACH_BYTES,
  isValidEmail,
  sanitizeReportHtml,
  normalizeAttachments,
  buildEmailHtml,
  sendEmail,
} = require('../lib/email');
const { inlineCidImages, renderHtmlToPdf } = require('../lib/pdf');

// Build a filename from the resolved subject, so a recipient saving three of
// these to a desktop ends up with three distinguishable files.
function pdfFilenameFor(subject) {
  const slug = String(subject || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
  return `${slug}-${new Date().toISOString().slice(0, 10)}.pdf`;
}

// Each report type → which division the caller must have access to.
const REPORT_TYPES = {
  executive:            { division: 'executive', label: 'Executive Report'                 },
  turf_daily_pm:        { division: 'turf',      label: 'Daily PM Report'                  },
  turf_daily_summary:   { division: 'turf',      label: 'Daily Summary Report'             },
  turf_bid_items:       { division: 'turf',      label: 'Bid Line Items vs Actuals — Turf' },
  turf_job_summary:     { division: 'turf',      label: 'Job Summary — Turf'               },
  turf_construction_schedule: { division: 'turf', label: 'Construction Schedule'           },
  paving_daily_pm:      { division: 'paving',    label: 'Daily PM Report'                    },
  paving_daily_summary: { division: 'paving',    label: 'Daily Summary Report'               },
  paving_bid_items:     { division: 'paving',    label: 'Bid Line Items vs Actuals — Paving' },
  paving_job_summary:   { division: 'paving',    label: 'Job Summary — Paving'                },
  kiewit_daily_pm:      { division: 'kiewit',    label: 'Daily PM Report'                            },
  kiewit_daily_summary: { division: 'kiewit',    label: 'Daily Summary Report'                       },
  kiewit_bid_items:     { division: 'kiewit',    label: 'Bid Line Items vs Actuals — Kiewit Pinetree' },
  kiewit_job_summary:   { division: 'kiewit',    label: 'Job Summary — Kiewit Pinetree'               },
  kiewit_construction_schedule: { division: 'kiewit', label: 'Construction Schedule'                  },
  quarry_breakeven:     { division: 'quarry',    label: 'Quarry Break-Even Analysis'          },
  dust_tracking_summary:{ division: 'dust',      label: 'Dust Control Tracking Report'        },
  scheduler_dispatch:   { division: 'scheduler', label: 'Crew Dispatch Schedule'              },
  trucking_dispatch:    { division: 'trucking',  label: 'Trucking Dispatch Schedule'          },
  // The Scheduler tab's second board. Same division — it is the trucking
  // office's own labor board — so the same access check applies.
  trucking_labor_dispatch: { division: 'trucking', label: 'Labor Dispatch Schedule'           },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
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

  const safeBody = sanitizeReportHtml(html);

  // Build subject — caller can override, fallback to a sensible default.
  let finalSubject = (typeof subject === 'string' && subject.trim()) || cfg.label;
  if (project_name && typeof project_name === 'string' && !finalSubject.includes(project_name)) {
    finalSubject = `${cfg.label} — ${String(project_name).trim()}`;
  }
  finalSubject = finalSubject.slice(0, 200);

  // Render the report to a PDF. `safeBody` is already stripped of <script>
  // (including the reports' own window.print() bootstrap), so what Chrome
  // loads is inert markup plus the report's own CSS.
  let pdfAttachment = null;
  let pdfPages      = null;
  let warning       = null;

  if (attachPdf) {
    const rendered = await renderHtmlToPdf(inlineCidImages(safeBody, att.attachments));
    if (rendered.ok) {
      pdfAttachment = {
        filename:    pdfFilenameFor(finalSubject),
        content:     rendered.buffer.toString('base64'),
        contentType: 'application/pdf',
      };
      pdfPages = rendered.pageCount;
    } else {
      warning = `The report was sent inline — PDF rendering failed: ${rendered.error}`;
      console.error('[email/send-report] pdf render failed:', rendered.error,
        'user=' + payload.username, 'report=' + report_type);
    }
  }

  // With the PDF attached, the caller's own attachments that existed only to
  // back an <img src="cid:..."> in the inline body have no referent any more —
  // they're baked into the PDF — so drop them rather than have them surface as
  // stray files. Anything the caller meant as a real attachment (no contentId)
  // still rides along.
  const carried = pdfAttachment
    ? att.attachments.filter(a => !a.inlineContentId)
    : att.attachments;
  const finalAttachments = pdfAttachment ? [...carried, pdfAttachment] : carried;

  if (finalAttachments.length > MAX_ATTACHMENTS) {
    return res.status(400).json({ ok: false, error: `Too many attachments (max ${MAX_ATTACHMENTS})` });
  }
  const attachBytes = finalAttachments.reduce(
    (n, a) => n + Buffer.byteLength(String(a.content || ''), 'base64'), 0);
  if (attachBytes > MAX_ATTACH_BYTES) {
    return res.status(413).json({ ok: false, error: 'The report is too large to attach — narrow the date range or cost codes and try again.' });
  }

  const wrapped = buildEmailHtml({
    title:        finalSubject,
    note,
    // The full table goes in the body only when there's no PDF carrying it.
    bodyHtml:     pdfAttachment ? '' : safeBody,
    summary,
    attachmentNote: pdfAttachment
      ? `Full report attached as PDF${pdfPages ? ` (${pdfPages} page${pdfPages === 1 ? '' : 's'})` : ''}.`
      : null,
    companyName:  payload.companyName,
    generatedAt:  new Date().toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  });

  const result = await sendEmail({
    to:          cleaned,
    subject:     finalSubject,
    html:        wrapped,
    attachments: finalAttachments,
  });

  if (!result.ok) {
    console.error('[email/send-report] failed:',
      result.error,
      'user=' + payload.username,
      'company=' + payload.companyCode,
      'report=' + report_type
    );
    return res.status(502).json({ ok: false, error: result.error || 'Email send failed' });
  }

  console.log('[email/send-report] sent',
    'id=' + result.id,
    'user=' + payload.username,
    'company=' + payload.companyCode,
    'report=' + report_type,
    'recipients=' + cleaned.length,
    'pdf=' + (pdfAttachment ? (pdfPages ? pdfPages + 'p' : 'yes') : 'no')
  );

  return res.json({
    ok:             true,
    id:             result.id,
    recipientCount: cleaned.length,
    pdfAttached:    Boolean(pdfAttachment),
    ...(pdfPages ? { pdfPages } : {}),
    ...(warning ? { warning } : {}),
  });
};
