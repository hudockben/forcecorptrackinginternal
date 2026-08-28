'use strict';

// Shared helpers for sending report emails via Resend.
// Centralizes the API key check, sanitization of caller-supplied HTML,
// and the wrapper template so individual report endpoints stay small.

const RESEND_API_KEY      = process.env.RESEND_API_KEY || '';
const EMAIL_FROM_ADDRESS  = process.env.EMAIL_FROM_ADDRESS || '';
const EMAIL_REPLY_TO      = process.env.EMAIL_REPLY_TO || ''; // optional

const MAX_RECIPIENTS = 50;          // hard cap per send
const MAX_HTML_BYTES = 1_500_000;   // ~1.5 MB raw HTML; Resend itself caps higher
const MAX_ATTACHMENTS = 6;          // per send
const MAX_ATTACH_BYTES = 8_000_000; // ~8 MB total decoded; Resend caps at 40 MB/message
const MAX_SUMMARY_METRICS = 8;      // key figures shown above the attachment note
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

// Inline images / small docs only — keeps the endpoint from relaying arbitrary
// binaries. Extension → MIME sent to Resend for the attachment's content_type.
const ATTACH_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
};

function isValidEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

// Validate + normalize caller-supplied attachments into the Resend SDK's shape
// ({ filename, content, contentType, inlineContentId }).
// Input item: { filename, content (base64 string, no data: prefix), contentId? }.
// Returns { ok, attachments } or { ok:false, error }. Enforces count, per-file
// extension allowlist, and a total decoded-byte cap. Content is validated by
// decoding to a Buffer (to check it's real base64 and measure size) and
// re-emitted as a canonical base64 STRING — the Resend SDK JSON.stringifies
// attachments verbatim (it does NOT base64-encode Buffers, so a Buffer would
// serialize to {"type":"Buffer",...} and corrupt the file), and the API's
// `content` field is base64 text.
function normalizeAttachments(raw) {
  if (raw == null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments must be an array' };
  if (raw.length > MAX_ATTACHMENTS) return { ok: false, error: `Too many attachments (max ${MAX_ATTACHMENTS})` };

  const out = [];
  let total = 0;
  for (const a of raw) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'Invalid attachment' };
    const filename = String(a.filename || '').trim().replace(/[\\/]/g, '').slice(0, 120);
    if (!filename) return { ok: false, error: 'Attachment filename is required' };
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mime = ATTACH_MIME[ext];
    if (!mime) return { ok: false, error: `Unsupported attachment type: .${ext}` };
    if (typeof a.content !== 'string' || !a.content) return { ok: false, error: 'Attachment content is required' };
    const b64 = a.content.includes(',') ? a.content.slice(a.content.indexOf(',') + 1) : a.content;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { ok: false, error: 'Attachment content must be base64' };
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: 'Attachment content is not valid base64' }; }
    if (!buf.length) return { ok: false, error: 'Attachment is empty' };
    total += buf.length;
    if (total > MAX_ATTACH_BYTES) return { ok: false, error: 'Attachments are too large' };
    // Field names must match the Resend SDK's Attachment interface (camelCase):
    // it reads `contentType` and `inlineContentId` and maps them to the API's
    // content_type / inline_content_id. `inlineContentId` is what makes the
    // attachment inline so <img src="cid:..."> resolves. `content` is a
    // canonical base64 string (see the function header for why not a Buffer).
    const item = { filename, content: buf.toString('base64'), contentType: mime };
    if (a.contentId != null) {
      const cid = String(a.contentId).trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
      if (cid) item.inlineContentId = cid;
    }
    out.push(item);
  }
  return { ok: true, attachments: out };
}

// Conservative HTML sanitizer for report bodies. Email clients themselves
// strip <script> + on*= handlers, but we sanitize server-side as defense in
// depth so a logged-in caller can't use the endpoint to relay arbitrary HTML.
// We strip:
//   - <script>, <iframe>, <object>, <embed>, <link>, <meta>, <base> tags
//   - on*= event handlers
//   - href="javascript:..." / src="javascript:..."
// We keep inline styles and tables (the existing print HTML relies on them).
function sanitizeReportHtml(html) {
  if (typeof html !== 'string') return '';

  let out = html;

  // Drop dangerous tag blocks entirely (including content).
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => {
    // Keep <style> blocks but neutralize @import / javascript: refs.
    const safeCss = String(css || '')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/javascript\s*:/gi, '');
    return `<style>${safeCss}</style>`;
  });
  out = out.replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');

  // Strip on*= event-handler attributes — match attribute name then value
  // whether it's "..."  / '...'  / unquoted.
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Neutralize javascript: in href / src.
  out = out.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');

  return out;
}

// Normalize caller-supplied summary metrics into at most MAX_SUMMARY_METRICS
// { label, value } pairs. These are the key figures the report already shows in
// its own header strip (Bid Budget, Actual Cost, ...) — the client lifts them
// out of the report HTML so the email body stays skimmable on a phone while
// the full table travels as the PDF.
function normalizeSummary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const label = String(m.label ?? '').trim().slice(0, 40);
    const value = String(m.value ?? '').trim().slice(0, 60);
    if (!label || !value) continue;
    out.push({ label, value });
    if (out.length >= MAX_SUMMARY_METRICS) break;
  }
  return out;
}

// Wrap the sanitized report body in a basic email shell. Adds a header with
// the report title and an optional caller note, plus a footer. Inline styles
// only — email clients ignore most <head>/<style> blocks.
//
// When the report rides along as a PDF, `bodyHtml` is left empty and the body
// carries just the note, the `summary` figures and `attachmentNote` instead of
// the full table — which is the whole point, since that table is what email
// clients mangle.
function buildEmailHtml({ title, note, bodyHtml, companyName, generatedAt, summary, attachmentNote }) {
  const safeTitle = String(title || 'Report').slice(0, 200);
  const safeNote  = note ? String(note).slice(0, 2000) : '';
  const company   = companyName ? String(companyName).slice(0, 120) : '';
  const metrics   = normalizeSummary(summary);
  const ts        = generatedAt || new Date().toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));

  const noteBlock = safeNote
    ? `<div style="background:#f8f9fa;border-left:3px solid #0ea5e9;padding:10px 14px;margin-bottom:18px;font-size:13px;color:#374151;white-space:pre-wrap">${esc(safeNote)}</div>`
    : '';

  // Laid out as a table, two metrics per row: flexbox and CSS grid are both
  // unreliable in Outlook, and a table degrades to a readable stack on mobile.
  let summaryBlock = '';
  if (metrics.length) {
    const cells = metrics.map(m => `
        <td width="50%" style="padding:8px 12px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">${esc(m.label)}</div>
          <div style="font-size:17px;font-weight:800;color:#111;margin-top:2px;">${esc(m.value)}</div>
        </td>`);
    if (cells.length % 2) cells.push('<td width="50%"></td>');
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
      rows.push(`<tr>${cells[i]}${cells[i + 1]}</tr>`);
    }
    summaryBlock = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border-collapse:separate;background:#f3f9f4;border:1px solid #c6e0cb;border-radius:6px;margin-bottom:18px;">
      ${rows.join('')}
    </table>`;
  }

  const attachBlock = attachmentNote
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 14px;font-size:13px;color:#1e40af;font-weight:600;">
         &#128206; ${esc(String(attachmentNote).slice(0, 200))}
       </div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(safeTitle)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:920px;margin:0 auto;background:#fff;">
    <div style="padding:18px 24px;border-bottom:2px solid #111;background:#fff;">
      <div style="font-size:11px;color:#6b7280;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">${esc(company || 'DataWatch')}</div>
      <div style="font-size:19px;font-weight:800;color:#111;margin-top:2px;">${esc(safeTitle)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:2px;">Generated ${esc(ts)}</div>
    </div>
    <div style="padding:18px 24px;">
      ${noteBlock}
      ${summaryBlock}
      ${attachBlock}
      ${bodyHtml || ''}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#fafafa;font-size:11px;color:#9ca3af;text-align:center;">
      Sent via DataWatch &middot; Force Corp Tracking
    </div>
  </div>
</body></html>`;
}

// Send via Resend. Returns { ok, id, error }. Never throws — callers check ok.
// `attachments` (optional) is an array in the Resend SDK's shape:
//   { filename, content: Buffer|base64String, contentType?, inlineContentId? }
// Inline images are referenced from the HTML via <img src="cid:<inlineContentId>">.
async function sendEmail({ to, subject, html, replyTo, attachments }) {
  if (!RESEND_API_KEY)     return { ok: false, error: 'RESEND_API_KEY is not configured on the server.' };
  if (!EMAIL_FROM_ADDRESS) return { ok: false, error: 'EMAIL_FROM_ADDRESS is not configured on the server.' };
  if (!Array.isArray(to) || to.length === 0) return { ok: false, error: 'No recipients.' };
  if (!html) return { ok: false, error: 'Email body is empty.' };

  // Resend SDK is ESM-only in v4 — require() at call time instead of module
  // top so a require failure can be reported back to the caller.
  let Resend;
  try {
    ({ Resend } = require('resend'));
  } catch (err) {
    return { ok: false, error: `Resend SDK not installed: ${err.message}` };
  }

  try {
    const resend = new Resend(RESEND_API_KEY);
    const result = await resend.emails.send({
      from:    EMAIL_FROM_ADDRESS,
      to,
      subject: subject || 'DataWatch Report',
      html,
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      ...(replyTo || EMAIL_REPLY_TO ? { replyTo: replyTo || EMAIL_REPLY_TO } : {}),
    });
    if (result && result.error) return { ok: false, error: result.error.message || String(result.error) };
    return { ok: true, id: result?.data?.id || null };
  } catch (err) {
    return { ok: false, error: err.message || 'Email send failed.' };
  }
}

module.exports = {
  MAX_RECIPIENTS,
  MAX_HTML_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACH_BYTES,
  MAX_SUMMARY_METRICS,
  isValidEmail,
  normalizeSummary,
  sanitizeReportHtml,
  normalizeAttachments,
  buildEmailHtml,
  sendEmail,
};
