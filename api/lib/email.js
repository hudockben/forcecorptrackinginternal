'use strict';

// Shared helpers for sending report emails via Resend.
// Centralizes the API key check, sanitization of caller-supplied HTML,
// and the wrapper template so individual report endpoints stay small.

const RESEND_API_KEY      = process.env.RESEND_API_KEY || '';
const EMAIL_FROM_ADDRESS  = process.env.EMAIL_FROM_ADDRESS || '';
const EMAIL_REPLY_TO      = process.env.EMAIL_REPLY_TO || ''; // optional

const MAX_RECIPIENTS = 50;          // hard cap per send
const MAX_HTML_BYTES = 1_500_000;   // ~1.5 MB raw HTML; Resend itself caps higher
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function isValidEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
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

// Wrap the sanitized report body in a basic email shell. Adds a header with
// the report title and an optional caller note, plus a footer. Inline styles
// only — email clients ignore most <head>/<style> blocks.
function buildEmailHtml({ title, note, bodyHtml, companyName, generatedAt }) {
  const safeTitle = String(title || 'Report').slice(0, 200);
  const safeNote  = note ? String(note).slice(0, 2000) : '';
  const company   = companyName ? String(companyName).slice(0, 120) : '';
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
      ${bodyHtml}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#fafafa;font-size:11px;color:#9ca3af;text-align:center;">
      Sent via DataWatch · Force Corp Tracking
    </div>
  </div>
</body></html>`;
}

// Send via Resend. Returns { ok, id, error }. Never throws — callers check ok.
async function sendEmail({ to, subject, html, replyTo }) {
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
  isValidEmail,
  sanitizeReportHtml,
  buildEmailHtml,
  sendEmail,
};
