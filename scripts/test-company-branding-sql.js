#!/usr/bin/env node
'use strict';
/**
 * Company branding (Custom Reporting v2), against a real Postgres:
 * api/company/branding.js — the company's display name, logo and contact line
 * on customer reports.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-company-branding-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql. The
 * CUSTOM REPORTING V2 section is applied again here (it is idempotent).
 * Refuses a database whose name does not look like a test database; it
 * creates and removes two companies of its own.
 *
 * Every request goes through the real sign-in path (a real token, the account
 * read from the users table).
 *
 * What this pins down:
 *   - anyone signed in to the company reads it; only a company admin (users
 *     role admin, a platform admin, or an admin of any division) writes it;
 *   - a logo is accepted only as a real PNG or JPEG — its own first bytes, not
 *     a claimed type — with its pixel size read from the PNG header or the
 *     JPEG frame header and held to 1200 × 600; SVG, anything unreadable,
 *     over 200 KB decoded, or a body over 400 KB is refused;
 *   - what is stored is the decoded bytes re-encoded, and the type and size
 *     the server read, never the browser's word;
 *   - text is cleaned of control characters and held to its limits, and a
 *     website must be http or https;
 *   - a save changes only the fields it sends.
 */

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'company-branding-test-secret';

const CO  = 'CBTEST';
const CO2 = 'CBTEST2';
const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}
const DB = { fail: false };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(client);
      return (strings, ...values) => {
        if (DB.fail && strings.join('?').includes('company_branding')) return Promise.reject(new Error('connection reset'));
        return sql(strings, ...values);
      };
    } };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const jwt = require('jsonwebtoken');
const handler = require(path.join(ROOT, 'api/company/branding.js'));
const { sniffImage } = handler._internals;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const show = r => `${r.statusCode} ${JSON.stringify(r.body).slice(0, 300)}`;

async function call(method, body, user, headers = {}) {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
  const h = { ...headers, ...(user ? { authorization: 'Bearer ' + (typeof user === 'string' ? user : user.token) } : {}) };
  await handler({ method, query: {}, body: body === undefined ? {} : body, headers: h }, res);
  return res;
}
const get = user => call('GET', null, user);
const put = (user, body, headers) => call('PUT', body, user, headers);

// ── Images ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const PNG_SIG = Buffer.from('89504e470d0a1a0a', 'hex');
/** A real PNG, w × h, RGB, optionally padded with a tEXt chunk to exactly `size` bytes. */
function png(w, h, size = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3 + 1] = (x * 7 + y * 3) & 0xff;
  const head = [PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw))];
  const tail = chunk('IEND', Buffer.alloc(0));
  let out = Buffer.concat([...head, tail]);
  if (size) {
    const fill = size - out.length - 12;
    if (fill < 9) throw new Error('cannot pad a PNG to ' + size);
    const text = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(fill - 8, 0x61)]);
    out = Buffer.concat([...head, chunk('tEXt', text), tail]);
  }
  return out;
}
// A real 64 × 32 JPEG (JFIF, an ICC profile segment, then the frame header),
// as a browser canvas encodes one.
const JPEG_64x32 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAA'
  + 'ABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1'
  + 'AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAP'
  + 'KnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/'
  + '2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKCh'
  + 'MoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgAEADASIAAhEBAxEB/8QAGAABAAMB'
  + 'AAAAAAAAAAAAAAAAAAUGCAf/xAArEAEAAAEICQUAAAAAAAAAAAAABgECAxESFBcyBAUIExUjVaTSMUZRhMP/xAAZAQACAwEAAAAAAAAAAAAAAA'
  + 'AAAgEDBAX/xAAgEQACAgEEAwEAAAAAAAAAAAAAAQIRAwQSEzEhMmGB/9oADAMBAAIRAxEAPwCgA3QyQhvOBptNz35qjC43Q4XtPe2vs/kaWLar'
  + 'stz6Hig57rr4cLAUmAAAAvWLMbda7Wg8FFEptdDRySh6ui9Ysxt1rtaDwQUTxbruKLtx3Tb1drW65UyZZtVV5ZsleWT1+EEJcm+2NLLkkqlJv9'
  + 'ABSsAAD//Z', 'base64');
/** The JPEG with its frame header's size rewritten (and segments spliced in front, if any). */
function jpegSized(w, h, { sof = 0xc0, before = [] } = {}) {
  const b = Buffer.from(JPEG_64x32);
  const at = b.indexOf(Buffer.from([0xff, 0xc0]));
  b[at + 1] = sof; b.writeUInt16BE(h, at + 5); b.writeUInt16BE(w, at + 7);
  return Buffer.concat([b.subarray(0, 2), ...before, b.subarray(2)]);
}
const app1 = n => { const s = Buffer.alloc(n + 4); s[0] = 0xff; s[1] = 0xe1; s.writeUInt16BE(n + 2, 2); s.write('Exif\0\0', 4, 'latin1'); return s; };
const b64 = buf => buf.toString('base64');
const logo = (buf, mime) => ({ logo: { base64: b64(buf), ...(mime ? { mime } : {}) } });

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await client.query('DELETE FROM company_branding WHERE company_code = $1', [co]).catch(() => {});
    await client.query('DELETE FROM users WHERE company_code = $1', [co]);
    await client.query('DELETE FROM companies WHERE code = $1', [co]);
  }
}
async function applyV2() {
  const file = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
  const at = file.indexOf('\n-- CUSTOM REPORTING V2');
  if (at < 0) throw new Error('neon-schema.sql has no CUSTOM REPORTING V2 section');
  const stmts = file.slice(file.lastIndexOf('\n-- ─', at)).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  for (const s of stmts) await client.query(s);
}

(async () => {
  await client.connect();
  await applyV2();
  await cleanUp();
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Branding test', '{turf,paving,kiewit}')", [CO]);
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Rival Co', '{turf,paving}')", [CO2]);
  const mk = async (username, roles, { co = CO, platform = false, role = 'level1' } = {}) => {
    const id = (await client.query(
      'INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin) VALUES ($1, $2, \'x\', $3, $4, $5) RETURNING id',
      [username, co, role, roles ? JSON.stringify(roles) : null, platform])).rows[0].id;
    // Claims are deliberately generous: the users row decides.
    const token = jwt.sign({ userId: id, username, companyCode: co, role: 'admin', isPlatformAdmin: false }, process.env.JWT_SECRET);
    return { id, username, token };
  };
  const ADMIN  = await mk('b_admin', { turf: 'admin', paving: 'admin' });
  const PAVADM = await mk('b_paving_admin', { turf: 'level1', paving: 'admin' });
  const LEGACY = await mk('b_legacy_admin', null, { role: 'admin' });
  const L3     = await mk('b_l3', { turf: 'level3', paving: 'level3' });
  const L1     = await mk('b_l1', { paving: 'level1' });
  const SALES  = await mk('b_sales', { turf: 'sales', paving: 'sales' });
  const PLAT   = await mk('b_platform', {}, { platform: true });
  const RIVAL  = await mk('b_rival', { turf: 'admin' }, { co: CO2 });

  // ─────────────────────────────────────────────────────────────────────
  console.log('Reading and who may write');
  {
    let r = await get(L1);
    assert('anyone signed in reads it: nothing set yet → branding null, canEdit false',
      r.statusCode === 200 && r.body.ok && r.body.branding === null && r.body.canEdit === false, show(r));
    r = await get(SALES);
    assert('…a sales login too (a scheduled send runs as whoever saved it)', r.statusCode === 200 && r.body.canEdit === false, show(r));
    for (const [who, u, want] of [['an admin', ADMIN, true], ['an admin of one division only', PAVADM, true],
      ['a legacy users.role admin', LEGACY, true], ['a platform admin', PLAT, true], ['a level3', L3, false]]) {
      r = await get(u);
      assert(`${who}: canEdit ${want}`, r.statusCode === 200 && r.body.canEdit === want, show(r));
    }
    for (const [who, u] of [['a level3', L3], ['a level1', L1], ['a sales login', SALES]]) {
      r = await put(u, { display_name: 'Hijack' });
      assert(`${who} cannot save it (403), whatever the token claims`, r.statusCode === 403, show(r));
    }
    assert('…and nothing was written', (await client.query('SELECT count(*)::int AS n FROM company_branding WHERE company_code = $1', [CO])).rows[0].n === 0);
    r = await call('GET', null, null);
    assert('no login → 401', r.statusCode === 401, show(r));
    r = await call('GET', null, 'junk-token');
    assert('a bad token → 401', r.statusCode === 401, show(r));
    r = await call('DELETE', null, ADMIN);
    assert('DELETE → 405', r.statusCode === 405, show(r));
    r = await call('OPTIONS', null, null);
    assert('OPTIONS → 200 without a login', r.statusCode === 200);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nText fields');
  {
    let r = await put(ADMIN, {
      display_name: '  Acme\u0000 Paving\t& Sons ', phone: '(724) 555-0100', email: ' Office@Acme.example.COM ',
      website: 'www.acme.example.com', address: '12 Main St\r\nGreensburg, PA 15601\u0007', report_footer: 'Licensed & insured\nPA123456',
    });
    const b = r.body && r.body.branding;
    assert('an admin saves the company\'s branding (200)', r.statusCode === 200 && b, show(r));
    assert('…one-line text cleaned of control characters, trimmed', b.display_name === 'Acme Paving & Sons' && b.phone === '(724) 555-0100', JSON.stringify(b));
    assert('…the email lower-cased, a bare website given https://', b.email === 'office@acme.example.com' && b.website === 'https://www.acme.example.com', JSON.stringify(b));
    assert('…address and footer keep their line breaks, nothing else', b.address === '12 Main St\nGreensburg, PA 15601' && b.report_footer === 'Licensed & insured\nPA123456', JSON.stringify(b));
    assert('…with who saved it and when, and no logo yet', b.updated_by_username === 'b_admin' && b.updated_at && b.logo === null, JSON.stringify(b));
    const row = (await client.query('SELECT * FROM company_branding WHERE company_code = $1', [CO])).rows[0];
    assert('the row is the company default (division \'\')', row.division === '' && row.updated_by_user_id === ADMIN.id);
    r = await get(L1);
    assert('everyone reads it back', r.body.branding && r.body.branding.display_name === 'Acme Paving & Sons', show(r));

    r = await put(PAVADM, { phone: '724-555-0199' });
    assert('a save changes only what it sends', r.statusCode === 200 && r.body.branding.phone === '724-555-0199'
      && r.body.branding.display_name === 'Acme Paving & Sons' && r.body.branding.website === 'https://www.acme.example.com'
      && r.body.branding.updated_by_username === 'b_paving_admin', show(r));
    r = await put(ADMIN, { report_footer: '', address: null });
    assert('\'\' and null clear a field', r.statusCode === 200 && r.body.branding.report_footer === null && r.body.branding.address === null, show(r));
    r = await put(ADMIN, { display_name: 12345 });
    assert('a number is taken as text', r.statusCode === 200 && r.body.branding.display_name === '12345', show(r));
    await put(ADMIN, { display_name: 'Acme Paving & Sons' });

    const bad = [
      [{ display_name: 'n'.repeat(121) }, 'a 121-character display name'],
      [{ phone: '1'.repeat(41) }, 'a 41-character phone'],
      [{ email: 'office@' }, 'an invalid email'],
      [{ website: 'javascript:alert(1)' }, 'a javascript: website'],
      [{ website: 'data:text/html,<script>' }, 'a data: website'],
      [{ website: 'ftp://acme.example.com' }, 'an ftp website'],
      [{ website: 'https://acme.example.com/a b' }, 'a website with a space'],
      [{ website: 'https://acme.example.com/"onmouseover="x' }, 'a website with a quote'],
      [{ website: 'https://' + 'a'.repeat(200) + '.com' }, 'a website over 200 characters'],
      [{ address: 'a'.repeat(301) }, 'a 301-character address'],
      [{ report_footer: 'f'.repeat(301) }, 'a 301-character footer'],
      [{ display_name: { x: 1 } }, 'a display name that is not text'],
    ];
    for (const [body, what] of bad) {
      r = await put(ADMIN, body);
      assert(`${what} → 400`, r.statusCode === 400 && typeof r.body.error === 'string', show(r));
    }
    r = await get(L1);
    assert('…and none of those changed anything', r.body.branding.display_name === 'Acme Paving & Sons' && r.body.branding.email === 'office@acme.example.com');
    r = await put(ADMIN, { display_name: 'n'.repeat(120), website: 'http://acme.example.com/about?x=1', address: 'a'.repeat(300) });
    assert('the limits themselves are fine, and http:// is kept as typed', r.statusCode === 200 && r.body.branding.website === 'http://acme.example.com/about?x=1', show(r));
    await put(ADMIN, { display_name: 'Acme Paving & Sons' });
    r = await put(ADMIN, ['a', 'list']);
    assert('a body that is a list → 400', r.statusCode === 400, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe logo');
  {
    const P600 = png(600, 200);
    let r = await put(ADMIN, logo(P600, 'image/png'));
    let l = r.body && r.body.branding && r.body.branding.logo;
    assert('a 600×200 PNG is accepted, its size read from the file', r.statusCode === 200 && l && l.mime === 'image/png' && l.width === 600 && l.height === 200, show(r));
    assert('…stored as the bytes it decodes to, re-encoded', l.base64 === b64(P600) && Buffer.from(l.base64, 'base64').equals(P600));
    assert('…and the rest of the branding is untouched', r.body.branding.display_name === 'Acme Paving & Sons');
    r = await get(SALES);
    assert('everyone reads the logo back', r.body.branding.logo && r.body.branding.logo.width === 600, show(r));
    r = await put(ADMIN, { display_name: 'Acme Paving' });
    assert('a save without a logo keeps the logo', r.body.branding.logo && r.body.branding.logo.base64 === b64(P600), show(r));

    r = await put(ADMIN, { logo: { base64: b64(P600), mime: 'image/png', width: 1, height: 1 } });
    assert('the browser\'s width and height are not trusted', r.body.branding.logo.width === 600 && r.body.branding.logo.height === 200, show(r));
    r = await put(ADMIN, { logo: { base64: 'data:image/png;base64,' + b64(png(10, 5)) } });
    assert('a data: URI is accepted', r.statusCode === 200 && r.body.branding.logo.width === 10 && r.body.branding.logo.height === 5, show(r));
    r = await put(ADMIN, logo(png(20, 10)));
    assert('…and so is plain base64 with no type claimed', r.statusCode === 200 && r.body.branding.logo.mime === 'image/png', show(r));
    r = await put(ADMIN, { logo: { base64: b64(png(30, 10)).replace(/(.{60})/g, '$1\n') } });
    assert('…with line breaks in the base64', r.statusCode === 200 && r.body.branding.logo.width === 30, show(r));

    r = await put(ADMIN, logo(JPEG_64x32, 'image/jpeg'));
    assert('a real JPEG is accepted, its size read from the frame header past the JFIF and ICC segments',
      r.statusCode === 200 && r.body.branding.logo.mime === 'image/jpeg' && r.body.branding.logo.width === 64 && r.body.branding.logo.height === 32, show(r));
    r = await put(ADMIN, logo(jpegSized(800, 300, { before: [app1(5000)] }), 'image/jpg'));
    assert('…one with a large EXIF segment first, claimed as image/jpg', r.statusCode === 200 && r.body.branding.logo.width === 800 && r.body.branding.logo.height === 300, show(r));
    r = await put(ADMIN, logo(jpegSized(640, 480, { sof: 0xc2 })));
    assert('…a progressive JPEG (SOF2)', r.statusCode === 200 && r.body.branding.logo.width === 640 && r.body.branding.logo.height === 480, show(r));

    r = await put(ADMIN, logo(png(1200, 600)));
    assert('1200×600 is the largest accepted', r.statusCode === 200 && r.body.branding.logo.width === 1200, show(r));
    const before = (await get(L1)).body.branding.logo.base64;
    const refused = [
      [logo(png(1201, 100)), 400, '1201 pixels wide'],
      [logo(png(100, 601)), 400, '601 pixels tall'],
      [logo(jpegSized(1300, 200)), 400, 'a JPEG 1300 pixels wide'],
      [logo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png'), 400, 'SVG claiming to be a PNG'],
      [logo(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 400, 'an XML SVG'],
      [logo(png(10, 10), 'image/svg+xml'), 400, 'a claimed image/svg+xml'],
      [{ logo: { base64: 'data:image/svg+xml;base64,' + b64(Buffer.from('<svg/>')) } }, 400, 'an SVG data: URI'],
      [{ logo: { base64: 'data:image/png,' + b64(png(5, 5)) } }, 400, 'a data: URI that is not base64'],
      [logo(png(10, 10), 'image/gif'), 400, 'a claimed image/gif'],
      [logo(Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex')), 400, 'a GIF'],
      [logo(JPEG_64x32, 'image/png'), 400, 'a JPEG claiming to be a PNG'],
      [logo(png(10, 10), 'image/jpeg'), 400, 'a PNG claiming to be a JPEG'],
      [logo(png(10, 10).subarray(0, 20)), 400, 'a PNG cut off before its size'],
      [logo(Buffer.concat([png(10, 10).subarray(0, 12), Buffer.from('IHDX'), png(10, 10).subarray(16)])), 400, 'a PNG whose first chunk is not IHDR'],
      [logo(png(0, 10)), 400, 'a PNG 0 pixels wide'],
      [logo(Buffer.from('ffd8ffd9', 'hex')), 400, 'a JPEG with no frame header'],
      [logo(Buffer.concat([Buffer.from('ffd8ffe0ffff', 'hex'), Buffer.alloc(10)])), 400, 'a JPEG whose segment runs off the end'],
      [logo(Buffer.from('ffd8ffda000c', 'hex')), 400, 'a JPEG reaching scan data before a frame header'],
      [logo(Buffer.from('just some text, not an image at all')), 400, 'plain text'],
      [{ logo: { base64: 'not*base64!' } }, 400, 'invalid base64'],
      [{ logo: { base64: '' } }, 400, 'an empty logo'],
      [{ logo: 'iVBORw0KGgo=' }, 400, 'a logo that is a bare string'],
      [{ logo: [1, 2] }, 400, 'a logo that is a list'],
      [logo(png(100, 50, 200 * 1024 + 1)), 413, 'a PNG one byte over 200 KB'],
    ];
    for (const [body, code, what] of refused) {
      r = await put(ADMIN, body);
      assert(`${what} → ${code}`, r.statusCode === code && typeof r.body.error === 'string', show(r));
    }
    assert('…and the saved logo is still the one before them', (await get(L1)).body.branding.logo.base64 === before);
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '\ufeff  <?xml version="1.0"?><svg/>']) {
      r = await put(ADMIN, logo(Buffer.from(svg, 'utf8')));
      assert(`SVG is named as the reason it is refused (${JSON.stringify(svg.slice(0, 12))}…)`, r.statusCode === 400 && /SVG logos are not accepted/.test(r.body.error), show(r));
    }
    const exact = png(100, 50, 200 * 1024);
    r = await put(ADMIN, logo(exact));
    assert('a PNG of exactly 200 KB is accepted', r.statusCode === 200 && Buffer.from(r.body.branding.logo.base64, 'base64').length === 200 * 1024, show(r));
    r = await put(ADMIN, { display_name: 'Acme Paving', pad: 'x'.repeat(400 * 1024) });
    assert('a body over 400 KB → 413', r.statusCode === 413, show(r));
    r = await put(ADMIN, { display_name: 'Small' }, { 'content-length': String(400 * 1024 + 1) });
    assert('…as declared by Content-Length, too', r.statusCode === 413, show(r));
    r = await put(ADMIN, { logo: null });
    assert('logo: null removes the logo, keeping the rest', r.statusCode === 200 && r.body.branding.logo === null && r.body.branding.display_name === 'Acme Paving', show(r));
    const row = (await client.query('SELECT logo_mime, logo_base64, logo_width, logo_height FROM company_branding WHERE company_code = $1 AND division = \'\'', [CO])).rows[0];
    assert('…every logo column cleared', row.logo_mime === null && row.logo_base64 === null && row.logo_width === null && row.logo_height === null, JSON.stringify(row));

    // The parser on its own.
    assert('sniffImage: PNG and JPEG sizes, nothing for anything else',
      JSON.stringify(sniffImage(png(7, 3))) === '{"mime":"image/png","width":7,"height":3}'
        && JSON.stringify(sniffImage(JPEG_64x32)) === '{"mime":"image/jpeg","width":64,"height":32}'
        && Boolean(sniffImage(Buffer.alloc(0)).error) && Boolean(sniffImage(Buffer.from('ffd8ff', 'hex')).error)
        && Boolean(sniffImage(Buffer.from('ffd8ff01', 'hex')).error));
    let fuzzBad = 0;
    for (let i = 0; i < 400; i++) {
      const src = i % 2 ? JPEG_64x32 : png(9, 4);
      const cut = src.subarray(0, Math.floor(Math.random() * src.length));
      const flip = Buffer.from(src); flip[Math.floor(Math.random() * flip.length)] ^= 0xff;
      for (const b of [cut, flip]) {
        try { const x = sniffImage(b); if (!x.error && !(x.width > 0 && x.height > 0)) fuzzBad++; } catch (e) { fuzzBad++; }
      }
    }
    assert('…and truncated or bit-flipped files never throw or give a zero size', fuzzBad === 0, fuzzBad);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nOther companies, platform admins, a database failure');
  {
    let r = await get(RIVAL);
    assert('another company sees none of it', r.statusCode === 200 && r.body.branding === null && r.body.canEdit === true, show(r));
    r = await put(RIVAL, { display_name: 'Rival Paving' });
    assert('…and saving its own writes only its own', r.statusCode === 200 && (await get(L1)).body.branding.display_name === 'Acme Paving', show(r));
    r = await put(PLAT, { display_name: 'Set by the platform' });
    assert('a platform admin may save it', r.statusCode === 200 && r.body.branding.display_name === 'Set by the platform'
      && r.body.branding.updated_by_username === 'b_platform', show(r));
    r = await put(LEGACY, { display_name: 'Legacy admin' });
    assert('…and so may a legacy account whose users.role is admin', r.statusCode === 200, show(r));
    DB.fail = true;
    r = await get(L1);
    DB.fail = false;
    assert('a database failure is a 500 that says so', r.statusCode === 500 && r.body.error === 'Database error', show(r));
  }

  await cleanUp();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await client.end(); } catch { /* already reporting the real failure */ }
  process.exit(1);
});
