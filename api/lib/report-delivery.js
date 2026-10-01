'use strict';

// Turn a built report into a sent email: sanitize, render the PDF, wrap the
// body, send.
//
// The one copy of that path. The Email Report button (api/email/send-report.js)
// and the scheduled sends (api/lib/report-schedule-runner.js) both come
// through here, so a report that goes out on its own at 6:30 is the same email
// — same PDF, same key figures, same fallback when the renderer is down — as
// the one somebody would have sent by hand.
//
// Callers validate who may send what and to whom; this validates only what it
// builds (the attachment count and size after the PDF joins them).

const {
  MAX_ATTACHMENTS,
  MAX_ATTACH_BYTES,
  sanitizeReportHtml,
  buildEmailHtml,
  sendEmail,
} = require('./email');
const { inlineCidImages, renderHtmlToPdf } = require('./pdf');

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

/**
 * Resolve the subject line: the caller's, else the report's label; a project
 * name not already in it is appended to the label.
 */
function finalSubjectFor({ subject, label, projectName }) {
  let s = (typeof subject === 'string' && subject.trim()) || label || 'Report';
  if (projectName && typeof projectName === 'string' && !s.includes(projectName)) {
    s = `${label} — ${String(projectName).trim()}`;
  }
  return s.slice(0, 200);
}

/**
 * Send one report.
 *
 *   deliverReport({
 *     label,          // the report's name, for the default subject
 *     projectName?,   // appended to the subject when not already in it
 *     recipients,     // cleaned, validated, de-duplicated emails
 *     subject?, note?,
 *     html,           // the report document the page built
 *     attachments,    // normalized (normalizeAttachments) — may be []
 *     summary?,       // key figures for the email body
 *     attachPdf,      // render `html` to an attached PDF
 *     companyName?,
 *     generatedAt?,   // display string for the email header
 *     browser?,       // a running Chrome to render in (see renderHtmlToPdf)
 *     logTag?,        // context for the server log on a render failure
 *   })
 *
 * Resolves to
 *   { ok: true, id, subject, pdfAttached, pdfPages?, warning? }
 *   | { ok: false, status, error }      status: 400 | 413 | 502
 *
 * Never throws for anything the email itself can cause.
 */
async function deliverReport(opts) {
  const {
    label, projectName, recipients, subject, note, html,
    summary, attachPdf, companyName, generatedAt, browser, logTag,
  } = opts;
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];

  const safeBody     = sanitizeReportHtml(html);
  const finalSubject = finalSubjectFor({ subject, label, projectName });

  // Render the report to a PDF. `safeBody` is already stripped of <script>
  // (including the reports' own window.print() bootstrap), so what Chrome
  // loads is inert markup plus the report's own CSS.
  let pdfAttachment = null;
  let pdfPages      = null;
  let warning       = null;

  if (attachPdf) {
    const rendered = await renderHtmlToPdf(inlineCidImages(safeBody, attachments), { browser });
    if (rendered.ok) {
      pdfAttachment = {
        filename:    pdfFilenameFor(finalSubject),
        content:     rendered.buffer.toString('base64'),
        contentType: 'application/pdf',
      };
      pdfPages = rendered.pageCount;
    } else {
      warning = `The report was sent inline — PDF rendering failed: ${rendered.error}`;
      console.error('[report-delivery] pdf render failed:', rendered.error, logTag || '');
    }
  }

  // With the PDF attached, the caller's own attachments that existed only to
  // back an <img src="cid:..."> in the inline body have no referent any more —
  // they're baked into the PDF — so drop them rather than have them surface as
  // stray files. Anything the caller meant as a real attachment (no contentId)
  // still rides along.
  const carried = pdfAttachment
    ? attachments.filter(a => !a.inlineContentId)
    : attachments;
  const finalAttachments = pdfAttachment ? [...carried, pdfAttachment] : carried;

  if (finalAttachments.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `Too many attachments (max ${MAX_ATTACHMENTS})` };
  }
  const attachBytes = finalAttachments.reduce(
    (n, a) => n + Buffer.byteLength(String(a.content || ''), 'base64'), 0);
  if (attachBytes > MAX_ATTACH_BYTES) {
    return { ok: false, status: 413, error: 'The report is too large to attach — narrow the date range or cost codes and try again.' };
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
    companyName,
    generatedAt:  generatedAt || new Date().toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  });

  const result = await sendEmail({
    to:          recipients,
    subject:     finalSubject,
    html:        wrapped,
    attachments: finalAttachments,
  });

  if (!result.ok) {
    return { ok: false, status: 502, error: result.error || 'Email send failed' };
  }

  return {
    ok:          true,
    id:          result.id,
    subject:     finalSubject,
    pdfAttached: Boolean(pdfAttachment),
    ...(pdfPages ? { pdfPages } : {}),
    ...(warning ? { warning } : {}),
  };
}

module.exports = { deliverReport, pdfFilenameFor, finalSubjectFor };
