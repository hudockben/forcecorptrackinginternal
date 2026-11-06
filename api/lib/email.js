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
const MAX_SUMMARY_METRICS = 12;     // key figures shown above the attachment note
// An address the mail service will take. Resend refuses a whole send when any
// one address on it is malformed — a recipient group holding
// "name@forcecorporation..com" sent its report to nobody — so a dot at either
// end of the name, two dots in a row, an empty or hyphen-edged domain label,
// and parts past the RFC 5321 lengths (64 name, 63 label, 254 whole) are
// turned away here, where the address can be named. Otherwise the same
// characters as ever: nothing this accepts was refused before.
// report-email.js carries a copy for the Email Report modal.
const EMAIL_RE = /^(?=.{1,254}$)(?=[^@]{1,64}@)[A-Za-z0-9_%+\-]+(?:\.[A-Za-z0-9_%+\-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

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
// It is pattern-matching, so it is hygiene, not a security boundary: anything
// that shows a stored report in the browser must still keep it from running
// (Customer History opens an archive in a frame sandboxed without scripts).
// We strip:
//   - <script>, <iframe>, <object>, <embed>, <link>, <meta>, <base> tags
//   - on*= event handlers: every on… attribute of a start tag, read the way
//     the browser reads it (stripHandlers below)
//   - href="javascript:..." / src="javascript:..."
// We keep inline styles and tables (the existing print HTML relies on them).
// The passes repeat until nothing changes, so markup that a removal splices
// back together (<scr<script></script>ipt>) is removed too.

// Where a start tag that opens at s[i] ("<" and a letter) ends, read as the
// HTML tokenizer reads it: a quote opens a value only right after "=", so a
// ">" inside a quoted value does not end the tag and a stray quote elsewhere
// does not start one. Returns the attributes it saw ({ from, to, name },
// `from` taking in the separators before the name) and the end (one past
// the ">", or the end of the input for a tag never closed).
const isHtmlSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
function readStartTag(s, i) {
  const attrs = [];
  let st = 'name', sep = -1, cur = null;
  const gap = j => { if (sep < 0) sep = j; };            // a run of separators starts
  const open = j => { cur = { from: sep >= 0 ? sep : j, at: j }; sep = -1; };
  const close = j => { if (j !== undefined) cur.to = j; attrs.push(cur); cur = null; };
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    switch (st) {
      case 'name':                                   // the tag name
        if (isHtmlSpace(c)) { st = 'before'; gap(j); }
        else if (c === '/') { st = 'slash'; gap(j); }
        else if (c === '>') return { attrs, end: j + 1 };
        break;
      case 'attr':                                   // an attribute name
        if (c === '=' || c === '>' || c === '/' || isHtmlSpace(c)) cur.name = s.slice(cur.at, j);
        if (c === '=') st = 'value?';
        else if (c === '>') { close(j); return { attrs, end: j + 1 }; }
        else if (c === '/') { close(j); st = 'slash'; gap(j); }
        else if (isHtmlSpace(c)) { cur.to = j; st = 'after'; gap(j); }
        break;
      case 'after':                                  // after a name, before any "="
        if (c === '=') { sep = -1; st = 'value?'; }
        else if (c === '>') { close(); return { attrs, end: j + 1 }; }
        else if (c === '/') { close(); st = 'slash'; }
        else if (!isHtmlSpace(c)) { close(); open(j); st = 'attr'; }
        break;
      case 'value?':                                 // after "=", before the value
        if (c === '"') st = 'dq';
        else if (c === "'") st = 'sq';
        else if (c === '>') { close(j); return { attrs, end: j + 1 }; }
        else if (!isHtmlSpace(c)) st = 'uq';
        break;
      case 'dq': if (c === '"') { close(j + 1); st = 'quoted'; } break;
      case 'sq': if (c === "'") { close(j + 1); st = 'quoted'; } break;
      case 'uq':                                     // an unquoted value
        if (isHtmlSpace(c)) { close(j); st = 'before'; gap(j); }
        else if (c === '>') { close(j); return { attrs, end: j + 1 }; }
        break;
      default:                                       // before a name, after a quoted value, after "/"
        if (c === '>') return { attrs, end: j + 1 };
        if (isHtmlSpace(c)) { st = 'before'; gap(j); }
        else if (c === '/') { st = 'slash'; gap(j); }
        else { open(j); st = 'attr'; }               // an "=" here starts a name
    }
  }
  // Never closed: what is open runs to the end (markup after the report —
  // the email shell's — could still close it).
  if (cur) {
    if (st === 'attr') cur.name = s.slice(cur.at);
    if (st === 'after') close(); else close(s.length);
  }
  return { attrs, end: s.length };
}
// Text that would be a handler if a parser read it as part of a tag — on…
// and its "=". Outside the attributes stripHandlers removes, only its "=" is
// written &#61;: report text ("Curb w/one = 6in", "Conditions = …") reads the
// same, in a cell or an attribute value (where entities decode), and should a
// browser still read it as an attribute it is one named "onerror&#61;…" that
// nothing runs. It matches wherever an attribute name could start — anywhere
// but straight after a letter (the tokenizer never begins a name inside a run
// of letters) — so a handler sitting straight after a closing quote ("<img
// src=\"x\"onerror=…"), a "/" or a space is defused too, while each run of
// letters is scanned once ("on" repeated through one would otherwise make
// every "on" a fresh start, and the sanitizer quadratic). Not applied to the
// spans stripHandlers keeps (CSS, <title>, <textarea>, comments …): entities
// are not decoded in CSS, so a defused "=" would corrupt it, and report words
// there should come through as written.
const HANDLER_LIKE = /(?<![a-z])(on[a-z]+\s*)=/gi;
const defuse = text => text.replace(HANDLER_LIKE, '$1&#61;');
// The same, but only where an attribute name could start: straight after a
// space, a "/" or a quote (the tokenizer begins a name nowhere else). Used on
// those spans (cutInSpan), so a handler in one is defused however the browser
// reads it, while "Conditions = dry" in a <title> stays as written.
const SPAN_HANDLER_LIKE = /(?<=[\s\/"'])(on[a-z]+\s*)=/gi;
// Elements whose content the HTML parser reads as text (RAWTEXT/RCDATA), not
// markup, up to the matching end tag. A start tag written inside such content
// — the </textarea> in `<b c='</textarea>` — is just text to a tag reader, but
// the real terminator to the browser, which then parses whatever follows (an
// <img onerror=…>) as its own tags. stripHandlers skips to the real end tag
// and keeps the span as the inert text it is, rather than letting readStartTag
// read an attribute value across the faked terminator and miss the
// handler-bearing tag beyond it. (script/iframe are removed upstream; the rest
// are listed so a confusion through them is closed regardless.)
const RAWTEXT_EL = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i;
// A span stripHandlers keeps (a comment, a CDATA section, a raw-text body).
// The browser may yet read it as markup — an svg/math <style>, <title> or
// <textarea> is an ordinary element there, "<!-->" closes at once, an HTML
// "<![CDATA[" ends at its first ">" — so it is not copied blind: each start
// tag in it, read bounded at the span's end, loses its on… attributes, and
// then any handler-like text still where an attribute name could start (one
// a comment or CDATA inside an svg <style> hid from that reading) is
// defused. Everything else is kept as written: CSS, and a <title>'s
// "Conditions = dry", come through byte for byte (words that do sit where an
// attribute could start, "Phase one = 1,200", get an &#61; a title decodes).
function cutInSpan(span) {
  const START = /<[A-Za-z]/g;
  let out = '', i = 0;
  for (;;) {
    START.lastIndex = i;
    const m = START.exec(span);
    if (!m) { out += span.slice(i); break; }
    out += span.slice(i, m.index);
    const { attrs, end } = readStartTag(span, m.index);
    let k = m.index;
    attrs.forEach(a => {
      if (!/^on[a-z]+$/i.test(a.name)) return;
      out += span.slice(k, a.from);
      const next = span[a.to];
      if (a.to < end && next !== undefined && !isHtmlSpace(next) && next !== '/' && next !== '>') out += ' ';
      k = a.to;
    });
    out += span.slice(k, end);
    i = end;
  }
  return out.replace(SPAN_HANDLER_LIKE, '$1&#61;');
}
/* Every on… attribute goes: each start tag is read as the browser reads it
   and its on… attributes are cut out (with the separators before them; a
   space stands in when the next attribute would otherwise run into the one
   before). Comments, CDATA sections and raw-text element bodies are kept as
   spans, to their real terminator, so a terminator faked inside one cannot put
   the reader out of step with the browser; but they are not copied blind,
   since the browser may read one as markup (cutInSpan). Text — between tags,
   and inside the attribute values left — is never cut, only defused, so the
   report's own words survive. */
const COMMENT_END = /--!?>/g;
function stripHandlers(html) {
  // A comment, a CDATA section (svg/math foreign content), or a start tag, in
  // source order. Anything else is ordinary text.
  const TOKEN = /<!--|<!\[CDATA\[|<[A-Za-z]/g;
  let out = '', i = 0;
  for (;;) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(html);
    if (!m) { out += defuse(html.slice(i)); break; }
    out += defuse(html.slice(i, m.index));
    const tok = m[0];
    if (tok === '<!--') {                                // a comment: keep inert, to --> / --!> / EOF
      // One forward scan for whichever comes first (the two never match at
      // one index): looking for each on its own would scan to the end of the
      // document for every comment, as reports have no "--!>".
      COMMENT_END.lastIndex = m.index + 4;
      const ce = COMMENT_END.exec(html);
      const stop = ce ? ce.index + ce[0].length : html.length;
      out += cutInSpan(html.slice(m.index, stop));
      i = stop;
      continue;
    }
    if (tok === '<![CDATA[') {                           // a CDATA section: keep inert, to ]]> / EOF
      const j = html.indexOf(']]>', m.index + 9);
      const stop = j >= 0 ? j + 3 : html.length;
      out += cutInSpan(html.slice(m.index, stop));
      i = stop;
      continue;
    }
    const { attrs, end } = readStartTag(html, m.index);  // a start tag: cut its on… attributes
    let tag = '', k = m.index;
    attrs.forEach(a => {
      if (!/^on[a-z]+$/i.test(a.name)) return;
      tag += defuse(html.slice(k, a.from));
      const next = html[a.to];
      if (a.to < end && next !== undefined && !isHtmlSpace(next) && next !== '/' && next !== '>') tag += ' ';
      k = a.to;
    });
    out += tag + defuse(html.slice(k, end));
    i = end;
    // If it opens a raw-text/RCDATA element, keep its body verbatim through the
    // real end tag so a faked terminator inside it can't be read across.
    const nameMatch = /^<([a-z0-9]+)/i.exec(html.slice(m.index, end));
    const selfClosed = html[end - 2] === '/';
    if (nameMatch && !selfClosed && RAWTEXT_EL.test(nameMatch[1])) {
      const close = new RegExp('</' + nameMatch[1] + '[\\s/>]', 'i');
      const cm = close.exec(html.slice(end));
      const stop = cm ? end + cm.index : html.length;
      out += cutInSpan(html.slice(end, stop));
      i = stop;
    }
  }
  return out;
}

function sanitizeOnce(html) {
  let out = html;

  // Drop dangerous tag blocks entirely (including content). A closing tag
  // may carry whitespace before its ">" (</script >), and a stray opening or
  // closing tag left over is dropped as well.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<\/?script\b[^>]*>/gi, '');
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css) => {
    // Keep <style> blocks but neutralize @import / javascript: refs.
    const safeCss = String(css || '')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/javascript\s*:/gi, '');
    return `<style>${safeCss}</style>`;
  });
  out = out.replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<\/?(iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');

  // Strip on*= event-handler attributes, wherever the browser would read
  // one: after whitespace, after a "/" (<img/onerror=x>), straight after a
  // quoted value, past a quoted ">". Text is defused, never cut.
  out = stripHandlers(out);

  // Neutralize javascript: in href / src.
  out = out.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');

  return out;
}
function sanitizeReportHtml(html) {
  if (typeof html !== 'string') return '';
  let out = html;
  for (let i = 0; i < 8; i++) {
    const next = sanitizeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// The report palette, for the figures that carry a color in the report's own
// header: green in the black or under bid, red over, amber for cost booked so
// far. A metric's `tone` may only name one of these.
const SUMMARY_TONES = { good: '#166534', bad: '#991b1b', actual: '#92400e' };
const SUMMARY_TONE_DEFAULT = '#111';

// Normalize caller-supplied summary metrics into at most MAX_SUMMARY_METRICS
// { label, value, tone? } entries. These are the key figures the report already
// shows in its own header strip (Contract Value, Bid Budget, Actual Profit,
// Actual Cost, ...) — the client lifts them out of the report HTML so the email
// body carries enough to act on without opening anything, while the full table
// travels as the PDF.
function normalizeSummary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const label = String(m.label ?? '').trim().slice(0, 40);
    const value = String(m.value ?? '').trim().slice(0, 60);
    if (!label || !value) continue;
    // Only a palette name survives — the tone reaches the markup as a color,
    // so an unrecognized one is dropped rather than passed through.
    const toneKey = String(m.tone ?? '');
    const tone = Object.prototype.hasOwnProperty.call(SUMMARY_TONES, toneKey) ? toneKey : null;
    out.push(tone ? { label, value, tone } : { label, value });
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
          <div style="font-size:17px;font-weight:800;color:${SUMMARY_TONES[m.tone] || SUMMARY_TONE_DEFAULT};margin-top:2px;">${esc(m.value)}</div>
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
