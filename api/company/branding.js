'use strict';

// /api/company/branding — the company's name, logo and contact line on the
// customer reports Custom Reporting builds.
//
// A report that goes to an owner should carry the contractor's name and logo,
// not the software's. The company admin sets them once (divisions.html →
// Manage System → Branding) and every custom report masthead, footer and the
// email that carries it use them.
//
// GET  → { ok, branding: { display_name, logo: { mime, base64, width, height } | null,
//                          phone, email, website, address, report_footer,
//                          updated_at, updated_by_username } | null,
//          canEdit }
//        Any signed-in user of the company: the builder needs it to draw the
//        masthead, and a scheduled send reads it as the account it runs as.
// PUT  { display_name?, logo?: { base64, mime? } | null, phone?, email?, website?,
//        address?, report_footer? }
//        Company admins only — the gate api/company/users.js uses (users.role
//        admin, or a platform admin) and, as the Email modal's groups do, an
//        admin in any division. Fields left out keep what is saved; null or ''
//        clears one; logo: null removes the logo.
//
// The row is company_branding's '' division, the company default.
//
// The logo is stored inline as base64, because the places it is drawn — the
// sandboxed preview, the print window, the PDF renderer (which loads nothing
// but data: URLs) — can only show a data: image. So it is checked hard here:
// PNG or JPEG by its own first bytes (a claimed type is not trusted, and SVG,
// which can carry script, is refused outright), at most MAX_LOGO_BYTES
// decoded, and its real width and height read from the PNG header or the
// JPEG frame header and held to MAX_LOGO_W × MAX_LOGO_H — a file whose size
// cannot be read is refused. What is stored is the decoded bytes re-encoded,
// with the type and size this file worked out, never the browser's word.

const { neon } = require('@neondatabase/serverless');
const { requireAuth } = require('../lib/auth');
const { isValidEmail } = require('../lib/email');

const MAX_BODY_BYTES   = 400 * 1024;
const MAX_LOGO_BYTES   = 200 * 1024;
const MAX_LOGO_W       = 1200;
const MAX_LOGO_H       = 600;
const LIMITS = { display_name: 120, phone: 40, email: 254, website: 200, address: 300, report_footer: 300 };
const MULTILINE = new Set(['address', 'report_footer']);
const LABELS = {
  display_name: 'Display name', phone: 'Phone', email: 'Email', website: 'Website',
  address: 'Address', report_footer: 'Report footer',
};

/** A company admin: users.role admin, a platform admin, or an admin of any division. */
function isCompanyAdmin(payload) {
  if (!payload) return false;
  if (payload.isPlatformAdmin || payload.role === 'admin') return true;
  const dr = payload.divisionRoles;
  return Boolean(dr) && typeof dr === 'object' && Object.values(dr).some(v => v === 'admin');
}

// NUL and half surrogate pairs are refused by Postgres; other control
// characters have no place in a name or a footer. Multi-line fields keep
// their line breaks.
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function cleanText(raw, multiline) {
  let s = String(raw).replace(BAD_CHARS, '').replace(/\r\n?/g, '\n');
  s = multiline
    ? s.replace(/[\u0001-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+\n/g, '\n')
    : s.replace(/[\u0001-\u001f\u007f]+/g, ' ');
  return s.trim();
}

function readField(key, raw) {
  if (raw === undefined) return { skip: true };
  if (raw === null) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${LABELS[key]} must be text` };
  let v = cleanText(raw, MULTILINE.has(key));
  if (!v) return { value: null };
  if (v.length > LIMITS[key]) return { error: `${LABELS[key]} is limited to ${LIMITS[key]} characters` };
  if (key === 'email') {
    v = v.toLowerCase();
    if (!isValidEmail(v)) return { error: `"${v.slice(0, 80)}" is not a valid email address` };
  }
  if (key === 'website') {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    let u = null;
    try { u = new URL(v); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname || !/^https?:\/\/[^\s"'<>`\\]+$/i.test(v)) {
      return { error: 'Website must be a web address (http or https)' };
    }
    if (v.length > LIMITS.website) return { error: `${LABELS.website} is limited to ${LIMITS.website} characters` };
  }
  return { value: v };
}

// ── The logo ─────────────────────────────────────────────────────────────
const BAD_LOGO = 'The logo must be a PNG or JPEG image whose size can be read.';

/** Type and pixel size from a PNG's IHDR or a JPEG's frame header, or { error }. */
function sniffImage(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    // The first chunk of every PNG is IHDR: length, "IHDR", width, height.
    if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return { error: BAD_LOGO };
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (!width || !height) return { error: BAD_LOGO };
    return { mime: 'image/png', width, height };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // Walk the marker segments to the first start-of-frame (SOF0–SOF15, not
    // DHT C4 / JPG C8 / DAC CC), which holds the height then the width.
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return { error: BAD_LOGO };
      while (i < buf.length && buf[i] === 0xff) i++;          // fill bytes
      if (i >= buf.length) return { error: BAD_LOGO };
      const m = buf[i++];
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;   // markers with no length
      if (m === 0xd9 || m === 0xda) return { error: BAD_LOGO }; // end or scan data before a frame header
      if (i + 2 > buf.length) return { error: BAD_LOGO };
      const len = buf.readUInt16BE(i);
      if (len < 2 || i + len > buf.length) return { error: BAD_LOGO };
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (len < 7) return { error: BAD_LOGO };
        const height = buf.readUInt16BE(i + 3), width = buf.readUInt16BE(i + 5);
        if (!width || !height) return { error: BAD_LOGO };
        return { mime: 'image/jpeg', width, height };
      }
      i += len;
    }
    return { error: BAD_LOGO };
  }
  return { error: BAD_LOGO };
}

/** A logo from the body, as { value: {mime, base64, width, height} } or { status, error }. */
function readLogo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, error: 'logo must be an object or null' };
  let b64 = typeof raw.base64 === 'string' ? raw.base64 : (typeof raw.data === 'string' ? raw.data : '');
  let claimed = typeof raw.mime === 'string' ? raw.mime.trim().toLowerCase() : '';
  const uri = /^data:([^;,]*)(;base64)?,/i.exec(b64);
  if (uri) {
    if (!uri[2]) return { status: 400, error: BAD_LOGO };
    claimed = claimed || uri[1].trim().toLowerCase();
    b64 = b64.slice(uri[0].length);
  }
  if (claimed && /svg/.test(claimed)) return { status: 400, error: 'SVG logos are not accepted — save the logo as a PNG or JPEG.' };
  if (claimed && claimed !== 'image/png' && claimed !== 'image/jpeg' && claimed !== 'image/jpg') {
    return { status: 400, error: BAD_LOGO };
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64 || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { status: 400, error: 'The logo is not valid base64.' };
  }
  // A base64 string decodes to at most 3/4 of its length: refuse before
  // decoding anything far too big.
  if (Math.floor(b64.length * 3 / 4) > MAX_LOGO_BYTES + 2) {
    return { status: 413, error: `The logo is too large — keep it under ${MAX_LOGO_BYTES / 1024} KB.` };
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { status: 400, error: 'The logo is empty.' };
  if (buf.length > MAX_LOGO_BYTES) {
    return { status: 413, error: `The logo is too large — keep it under ${MAX_LOGO_BYTES / 1024} KB.` };
  }
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (/^</.test(head) && /<svg|<\?xml/i.test(head)) {
    return { status: 400, error: 'SVG logos are not accepted — save the logo as a PNG or JPEG.' };
  }
  const img = sniffImage(buf);
  if (img.error) return { status: 400, error: img.error };
  if (claimed && (claimed === 'image/jpg' ? 'image/jpeg' : claimed) !== img.mime) {
    return { status: 400, error: `The logo says it is ${claimed} but is a ${img.mime === 'image/png' ? 'PNG' : 'JPEG'}.` };
  }
  if (img.width > MAX_LOGO_W || img.height > MAX_LOGO_H) {
    return { status: 400, error: `The logo is ${img.width}×${img.height} — keep it within ${MAX_LOGO_W}×${MAX_LOGO_H} pixels.` };
  }
  return { value: { mime: img.mime, base64: buf.toString('base64'), width: img.width, height: img.height } };
}

function shape(r) {
  if (!r) return null;
  return {
    display_name:        r.display_name || null,
    logo:                r.logo_base64 && r.logo_mime
      ? { mime: r.logo_mime, base64: r.logo_base64, width: r.logo_width == null ? null : Number(r.logo_width),
          height: r.logo_height == null ? null : Number(r.logo_height) }
      : null,
    phone:               r.phone || null,
    email:               r.email || null,
    website:             r.website || null,
    address:             r.address || null,
    report_footer:       r.report_footer || null,
    updated_at:          r.updated_at,
    updated_by_username: r.updated_by_username || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
  if (!payload) return;
  const company = payload.companyCode;
  if (!company) return res.status(401).json({ ok: false, error: 'Unauthorized — please log in' });
  const canEdit = isCompanyAdmin(payload);
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM company_branding WHERE company_code = ${company} AND division = ''`;
      return res.json({ ok: true, branding: shape(rows[0]), canEdit });
    }

    if (req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (!canEdit) return res.status(403).json({ ok: false, error: 'Company admin access required' });

    const declared = Number(req.headers && req.headers['content-length']);
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return res.status(400).json({ ok: false, error: 'Body must be an object' });
    }
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(b), 'utf8'); } catch { bytes = Infinity; }
    if ((Number.isFinite(declared) && declared > MAX_BODY_BYTES) || bytes > MAX_BODY_BYTES) {
      return res.status(413).json({ ok: false, error: 'Branding is too large — the logo must be under 200 KB.' });
    }

    const found = await sql`SELECT * FROM company_branding WHERE company_code = ${company} AND division = ''`;
    const cur = found[0] || {};
    const next = {
      display_name: cur.display_name ?? null, phone: cur.phone ?? null, email: cur.email ?? null,
      website: cur.website ?? null, address: cur.address ?? null, report_footer: cur.report_footer ?? null,
      logo_mime: cur.logo_mime ?? null, logo_base64: cur.logo_base64 ?? null,
      logo_width: cur.logo_width ?? null, logo_height: cur.logo_height ?? null,
    };
    for (const key of Object.keys(LIMITS)) {
      const f = readField(key, b[key]);
      if (f.error) return res.status(400).json({ ok: false, error: f.error });
      if (!f.skip) next[key] = f.value;
    }
    if (b.logo === null) {
      Object.assign(next, { logo_mime: null, logo_base64: null, logo_width: null, logo_height: null });
    } else if (b.logo !== undefined) {
      const l = readLogo(b.logo);
      if (l.error) return res.status(l.status).json({ ok: false, error: l.error });
      Object.assign(next, { logo_mime: l.value.mime, logo_base64: l.value.base64,
        logo_width: l.value.width, logo_height: l.value.height });
    }

    const userId = payload.userId != null && Number.isSafeInteger(Number(payload.userId)) ? Number(payload.userId) : null;
    const rows = await sql`
      INSERT INTO company_branding
        (company_code, division, display_name, logo_mime, logo_base64, logo_width, logo_height,
         phone, email, website, address, report_footer, updated_by_user_id, updated_by_username, updated_at)
      VALUES
        (${company}, '', ${next.display_name}, ${next.logo_mime}, ${next.logo_base64}, ${next.logo_width},
         ${next.logo_height}, ${next.phone}, ${next.email}, ${next.website}, ${next.address}, ${next.report_footer},
         ${userId}, ${payload.username || null}, NOW())
      ON CONFLICT (company_code, division) DO UPDATE SET
        display_name = EXCLUDED.display_name, logo_mime = EXCLUDED.logo_mime, logo_base64 = EXCLUDED.logo_base64,
        logo_width = EXCLUDED.logo_width, logo_height = EXCLUDED.logo_height, phone = EXCLUDED.phone,
        email = EXCLUDED.email, website = EXCLUDED.website, address = EXCLUDED.address,
        report_footer = EXCLUDED.report_footer, updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_by_username = EXCLUDED.updated_by_username, updated_at = NOW()
      RETURNING *`;
    return res.json({ ok: true, branding: shape(rows[0]), canEdit });
  } catch (err) {
    console.error('[company/branding] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
};

module.exports._internals = { sniffImage, readLogo, readField, isCompanyAdmin };
