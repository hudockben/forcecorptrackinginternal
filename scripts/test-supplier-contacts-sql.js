#!/usr/bin/env node
'use strict';
/**
 * Supplier contacts (api/supplier-contacts.js) against a real Postgres: the
 * people at a supplier that the Procurement tab remembers from its Contact
 * and Email cells, and that Admin → Suppliers lists and edits.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-supplier-contacts-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql. The
 * PROCUREMENT section is applied twice more here, split the way
 * scripts/run-schema.js splits it, so it must be idempotent. Refuses a
 * database whose name does not look like a test database; it creates and
 * removes two companies of its own.
 *
 * Every request goes through the real sign-in path and the real SQL, over a
 * connection POOL, so saves sent together really do race.
 *
 * What a stub cannot show, and this does:
 *   - "remember this contact" never makes a second copy of a person: the same
 *     email in any case, or with no email the same name, is the same contact,
 *     even when six rows save him at the same moment;
 *   - it only ever fills a blank — what somebody saved on purpose is never
 *     overwritten by whatever was typed on a row;
 *   - renaming a supplier moves its contacts, and onto a supplier that
 *     already has some it merges them, one copy of each person;
 *   - every query is scoped by company AND division, and who may write is the
 *     server's rule.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Pool } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'supplier-contacts-test-secret';

const CO  = 'SCTEST';
const CO2 = 'SCTEST2';
const pool = new Pool({ connectionString: URL, max: 12 });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

const DB = { fail: false, beforeCas: null, casLoses: false };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(pool);
      return (strings, ...values) => {
        const text = strings.join('?');
        if (DB.fail && text.includes('supplier_contacts')) return Promise.reject(new Error('connection reset by peer'));
        // The compare-and-set write of a purchase-order list (api/lib/po-sync.js).
        if (/UPDATE app_data\s+SET\s+value/.test(text) && /updated_at = \?::timestamptz/.test(text)) {
          // Somebody else saves the list between this request's read and its write.
          if (DB.beforeCas) { const f = DB.beforeCas; DB.beforeCas = null; return f().then(() => sql(strings, ...values)); }
          // …or keeps saving it, every time.
          if (DB.casLoses) return Promise.resolve([]);
        }
        return sql(strings, ...values);
      };
    } };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const jwt = require('jsonwebtoken');
const handler = require(path.join(ROOT, 'api/supplier-contacts.js'));
const B = require(path.join(ROOT, 'api/lib/data-backup.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const show = r => `${r.statusCode} ${JSON.stringify(r.body)}`;
const q = (text, values = []) => pool.query(text, values).then(r => r.rows);

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
}
async function call(method, query, body, user) {
  const res = fakeRes();
  const headers = user ? { authorization: 'Bearer ' + (typeof user === 'string' ? user : user.token) } : {};
  await handler({ method, query: query || {}, body: body === undefined ? {} : body, headers }, res);
  return res;
}
const list   = (user, division = 'turf') => call('GET', { division }, null, user);
const save   = (user, body, division = 'turf') => call('POST', { division }, body, user);
const rename = (user, from, to, division = 'turf') => call('POST', { division, action: 'rename' }, { from, to }, user);
const patch  = (user, id, body, division = 'turf') => call('PATCH', { division, id }, body, user);
const del    = (user, id, division = 'turf') => call('DELETE', { division, id }, null, user);
const rowOf  = async id => (await q('SELECT * FROM supplier_contacts WHERE id = $1', [id]))[0];
const liveOf = async (supplier, co = CO, division = 'turf') => q(
  `SELECT * FROM supplier_contacts WHERE company_code = $1 AND division = $2 AND deleted_at IS NULL AND lower(supplier_name) = lower($3)
    ORDER BY lower(name), lower(email)`, [co, division, supplier]);

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await q('DELETE FROM supplier_contacts WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM procurement_items WHERE company_code = $1', [co]).catch(() => {});
    await q("DELETE FROM app_data WHERE key LIKE $1 || ':%'", [co]).catch(() => {});
    await q('DELETE FROM purchase_orders WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM daily_tracking WHERE company_code = $1', [co]).catch(() => {});
    await q('DELETE FROM users WHERE company_code = $1', [co]);
    await q('DELETE FROM companies WHERE code = $1', [co]);
  }
}

// The PROCUREMENT section — from its header to the next section's — split
// the way scripts/run-schema.js splits it.
function sectionStatements() {
  const file = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
  const at = file.indexOf('\n-- PROCUREMENT (');
  if (at < 0) throw new Error('neon-schema.sql has no PROCUREMENT section');
  const headerEnd = file.indexOf('\n-- ─', at);
  const next = file.indexOf('\n-- ─', headerEnd + 1);
  return file.slice(file.lastIndexOf('\n-- ─', at), next < 0 ? file.length : next)
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

(async () => {
  console.log('The schema');
  {
    const stmts = sectionStatements();
    let error = null;
    for (let pass = 1; pass <= 2 && !error; pass++) {
      for (const s of stmts) {
        try { await q(s); } catch (err) { error = `pass ${pass}: ${err.message} in ${s.slice(0, 120)}`; break; }
      }
    }
    assert('the PROCUREMENT section applies twice in a row, split the run-schema way', !error && stmts.some(s => s.startsWith('CREATE TABLE IF NOT EXISTS supplier_contacts')), error);
    assert('…and holds only its own two tables\' statements', stmts.length === 21 && stmts.every(s => /procurement_items|supplier_contacts/.test(s)),
      `${stmts.length}: ` + stmts.filter(s => !/procurement_items|supplier_contacts/.test(s)).map(s => s.slice(0, 60)).join(' | '));
    const idx = (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'supplier_contacts'`)).map(i => i.indexdef).join('\n');
    assert('one live contact per email per supplier, and among contacts with no email one per name, both without case',
      /UNIQUE INDEX uq_supplier_contacts_email .*lower\(supplier_name\), lower\(email\).*deleted_at IS NULL\) AND \(email <> ''::text\)/.test(idx)
        && /UNIQUE INDEX uq_supplier_contacts_name .*lower\(supplier_name\), lower\(name\).*deleted_at IS NULL\) AND \(email = ''::text\)/.test(idx), idx);
  }

  await cleanUp();
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Contacts test', '{turf,paving,kiewit,dust}')", [CO]);
  await q("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Rival Co', '{turf,paving}')", [CO2]);
  const mk = async (username, roles, { co = CO, platform = false } = {}) => {
    const id = (await q(
      "INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin) VALUES ($1, $2, 'x', 'level1', $3, $4) RETURNING id",
      [username, co, JSON.stringify(roles), platform]))[0].id;
    const token = jwt.sign({ userId: id, username, companyCode: co, role: 'admin', divisionRoles: { turf: 'admin', paving: 'admin', kiewit: 'admin' } },
      process.env.JWT_SECRET);
    return { id, username, token };
  };
  const ADMIN = await mk('s_admin', { turf: 'admin', paving: 'admin' });
  const L3    = await mk('s_l3', { turf: 'level3' });
  const L2    = await mk('s_l2', { turf: 'level2', paving: 'level1' });
  const L1    = await mk('s_l1', { turf: 'level1', paving: 'level2' });
  const SALES = await mk('s_sales', { turf: 'sales' });
  const PAVE  = await mk('s_paving', { paving: 'level3' });
  const DUSTY = await mk('s_dust', { dust: 'admin' });
  const PLAT  = await mk('s_platform', {}, { platform: true });
  const RIVAL = await mk('s_rival', { turf: 'admin' }, { co: CO2 });

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWho may read and who may write');
  {
    let r = await list(L1);
    assert('a level1 user reads the contacts (200), canEdit false', r.statusCode === 200 && r.body.ok && r.body.canEdit === false && Array.isArray(r.body.contacts), show(r));
    for (const [who, u] of [['a level2', L2], ['a level3', L3], ['an admin', ADMIN], ['a platform admin', PLAT]]) {
      r = await list(u);
      assert(`${who} may edit (canEdit true)`, r.statusCode === 200 && r.body.canEdit === true, show(r));
    }
    r = await list(L2, 'paving');
    assert('…levels are per division (level1 in paving: canEdit false)', r.statusCode === 200 && r.body.canEdit === false, show(r));
    r = await list(SALES);
    assert('a sales login is refused (403 no_access)', r.statusCode === 403 && r.body.error === 'no_access', show(r));
    r = await save(SALES, { supplier_name: 'Acme', name: 'X' });
    assert('…and cannot save one', r.statusCode === 403, show(r));
    r = await list(PAVE);
    assert('a paving-only user is refused turf (403)', r.statusCode === 403, show(r));
    r = await list(DUSTY, 'dust');
    assert('a division without Procurement → 400', r.statusCode === 400 && r.body.error === 'division_not_supported', show(r));
    r = await call('GET', {}, null, ADMIN);
    assert('no division → 400', r.statusCode === 400, show(r));
    r = await call('GET', { division: 'turf' }, null, null);
    assert('no login → 401', r.statusCode === 401, show(r));
    r = await call('PUT', { division: 'turf' }, {}, ADMIN);
    assert('PUT → 405', r.statusCode === 405, show(r));
    r = await call('OPTIONS', { division: 'turf' }, {}, null);
    assert('OPTIONS → 200 without a login', r.statusCode === 200);
    for (const [what, p] of [
      ['save a contact', () => save(L1, { supplier_name: 'Acme', name: 'X' })],
      ['change one', () => patch(L1, 'sc-x', { name: 'Y' })],
      ['delete one', () => del(L1, 'sc-x')],
      ['move them on a rename', () => rename(L1, 'Acme', 'Acme 2')],
    ]) {
      r = await p();
      assert(`a level1 user cannot ${what} (403 read_only)`, r.statusCode === 403 && r.body.error === 'read_only', show(r));
    }
    r = await save(L1, { supplier_name: 'Paving Supply', name: 'Pat' }, 'paving');
    assert('…while the same person, level2 in paving, may save a paving contact (201)', r.statusCode === 201, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nRemembering a contact');
  let pat;
  {
    let r = await save(L2, { supplier_name: '  Acme Supply ', email: '  Pat@Acme.example ' });
    pat = r.body && r.body.contact;
    assert('a new contact → 201 existed:false', r.statusCode === 201 && r.body.existed === false && pat && pat.id, show(r));
    assert('…trimmed, the email kept as typed', pat.supplier_name === 'Acme Supply' && pat.email === 'Pat@Acme.example' && pat.name === '' && pat.phone === '', JSON.stringify(pat));
    assert('…with exactly { id, supplier_name, name, email, phone, updated_at }',
      JSON.stringify(Object.keys(pat).sort()) === JSON.stringify(['email', 'id', 'name', 'phone', 'supplier_name', 'updated_at']), Object.keys(pat).join(','));
    const row = await rowOf(pat.id);
    assert('…scoped to company and division, with who saved it', row.company_code === CO && row.division === 'turf' && row.created_by === 's_l2' && !row.deleted_at);

    r = await save(L3, { supplier_name: 'acme supply', name: 'Pat Jones', email: 'PAT@acme.EXAMPLE', phone: '724-555-0100' });
    assert('the same email in another case, under the supplier in another case → that contact (200, existed:true)',
      r.statusCode === 200 && r.body.existed === true && r.body.contact.id === pat.id, show(r));
    assert('…its blank name and phone filled in, its email and supplier name left as they were', r.body.contact.name === 'Pat Jones'
      && r.body.contact.phone === '724-555-0100' && r.body.contact.email === 'Pat@Acme.example' && r.body.contact.supplier_name === 'Acme Supply', show(r));
    const stamp = (await rowOf(pat.id)).updated_at.getTime();
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Patricia', email: 'pat@acme.example', phone: '999' });
    assert('a later save with other details never overwrites what is saved', r.statusCode === 200 && r.body.existed === true
      && r.body.contact.name === 'Pat Jones' && r.body.contact.phone === '724-555-0100', show(r));
    assert('…and, changing nothing, does not even touch the row', (await rowOf(pat.id)).updated_at.getTime() === stamp && (await rowOf(pat.id)).updated_by === 's_l3');

    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Dock Office' });
    const dock = r.body.contact;
    assert('a contact with a name and no email → 201', r.statusCode === 201 && dock.name === 'Dock Office' && dock.email === '', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'dock office', phone: '724-555-0199' });
    assert('the same name in another case, still no email → that contact, phone filled', r.statusCode === 200 && r.body.existed === true
      && r.body.contact.id === dock.id && r.body.contact.phone === '724-555-0199' && r.body.contact.name === 'Dock Office', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'DOCK OFFICE', phone: '111' });
    assert('…a different phone later is not written over it', r.body.contact.phone === '724-555-0199', show(r));

    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Sam' });
    const sam = r.body.contact;
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'sam', email: 'sam@acme.example' });
    assert('a name saved from one cell and its email from the next are one person: the email is filled in', r.statusCode === 200
      && r.body.existed === true && r.body.contact.id === sam.id && r.body.contact.email === 'sam@acme.example', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Sam' });
    assert('…and the name alone again finds him, rather than making an email-less Sam', r.statusCode === 200 && r.body.contact.id === sam.id, show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Sam', email: 'sam.other@acme.example' });
    assert('two Sams with different emails are two people (201)', r.statusCode === 201 && r.body.contact.id !== sam.id, show(r));
    r = await save(L2, { supplier_name: 'Other Supply', email: 'pat@acme.example' });
    assert('the same email under another supplier is another contact (201)', r.statusCode === 201 && r.body.contact.id !== pat.id, show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Phone In Email', email: '724-555-0123' });
    assert('an "email" that is a phone number is kept (never checked for shape)', r.statusCode === 201 && r.body.contact.email === '724-555-0123', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Tab\tName\u0000', email: 'tab@acme.example' });
    assert('control characters become spaces, NUL goes', r.statusCode === 201 && r.body.contact.name === 'Tab Name', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Given Id', id: 'sc-given-1' });
    assert('a client-minted id is used', r.statusCode === 201 && r.body.contact.id === 'sc-given-1', show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', name: 'Someone Else', id: 'sc-given-1' });
    assert('…an id already taken by another contact → 409 duplicate', r.statusCode === 409 && r.body.error === 'duplicate', show(r));

    const bad = [
      [{ name: 'X' }, 'no supplier'],
      [{ supplier_name: '   ', name: 'X' }, 'a blank supplier'],
      [{ supplier_name: 'Acme Supply' }, 'neither a name nor an email'],
      [{ supplier_name: 'Acme Supply', name: '  ', email: '' }, 'a blank name and email'],
      [{ supplier_name: 's'.repeat(121), name: 'X' }, 'a 121-character supplier'],
      [{ supplier_name: 'Acme Supply', name: 'n'.repeat(121) }, 'a 121-character name'],
      [{ supplier_name: 'Acme Supply', email: 'e'.repeat(201) }, 'a 201-character email'],
      [{ supplier_name: 'Acme Supply', name: 'X', phone: 'p'.repeat(61) }, 'a 61-character phone'],
      [{ supplier_name: 'Acme Supply', name: { first: 'X' } }, 'a name that is not text'],
      [{ supplier_name: 'Acme Supply', name: 'X', id: 'bad id' }, 'a junk id'],
    ];
    for (const [body, what] of bad) {
      r = await save(L2, body);
      assert(`${what} → 400`, r.statusCode === 400 && r.body.ok === false && typeof r.body.message === 'string', show(r));
    }
    r = await save(L2, ['a', 'list']);
    assert('a body that is a list → 400', r.statusCode === 400, show(r));
    r = await call('POST', { division: 'turf', action: 'explode' }, { supplier_name: 'Acme Supply', name: 'X' }, L2);
    assert('an unknown action → 400', r.statusCode === 400, show(r));
    assert('nothing refused was stored', (await liveOf('Acme Supply')).every(c => c.name !== 'X'));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSix rows saving the same person at once');
  {
    const results = await Promise.all(Array.from({ length: 6 }, (_, k) =>
      save(k % 2 ? L2 : L3, { supplier_name: 'Race Supply', name: k === 3 ? 'Riley' : '', email: k % 2 ? 'Riley@Race.example' : 'riley@race.example', phone: k === 5 ? '555' : '' })));
    assert('every save answers', results.every(x => x.statusCode === 200 || x.statusCode === 201), results.map(show).join(' | '));
    const rows = await liveOf('Race Supply');
    assert('…one contact, not six', rows.length === 1, JSON.stringify(rows));
    assert('…one save made it, the rest found it', results.filter(x => x.body.existed === false).length === 1
      && results.every(x => x.body.contact.id === rows[0].id), results.map(x => x.body.existed).join(','));
    assert('…and the blanks the others carried were filled in', rows[0].name === 'Riley' && rows[0].phone === '555', JSON.stringify(rows[0]));
    const byName = await Promise.all(Array.from({ length: 6 }, () => save(L2, { supplier_name: 'Race Supply', name: 'Front Desk' })));
    assert('six saves of a name with no email: one contact', (await liveOf('Race Supply')).filter(c => c.name === 'Front Desk').length === 1
      && byName.filter(x => x.body.existed === false).length === 1, byName.map(show).join(' | '));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nReading them');
  {
    let r = await list(L1);
    const names = r.body.contacts.map(c => `${c.supplier_name}/${c.name || c.email}`);
    assert('the division\'s live contacts, by supplier then name', r.statusCode === 200 && names[0].startsWith('Acme Supply/')
      && names.indexOf('Acme Supply/Dock Office') < names.indexOf('Acme Supply/Pat Jones') && names.some(n => n.startsWith('Race Supply/'))
      && names.some(n => n.startsWith('Other Supply/')), names.join(', '));
    r = await list(RIVAL);
    assert('another company sees none of them', r.statusCode === 200 && r.body.contacts.length === 0, show(r));
    r = await list(ADMIN, 'paving');
    assert('paving\'s list is paving\'s', r.body.contacts.length === 1 && r.body.contacts[0].supplier_name === 'Paving Supply', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nChanging and removing one');
  {
    let r = await patch(L3, pat.id, { name: 'Patricia Jones', phone: '724-555-0111' });
    assert('a level3 changes the name and phone on purpose (overwriting is what PATCH is for)', r.statusCode === 200
      && r.body.contact.name === 'Patricia Jones' && r.body.contact.phone === '724-555-0111' && r.body.contact.email === 'Pat@Acme.example', show(r));
    r = await patch(L2, pat.id, { email: 'SAM@acme.example' });
    assert('changing it to an email another of the supplier\'s contacts has (any case) → 409 duplicate, nothing changed',
      r.statusCode === 409 && r.body.error === 'duplicate' && (await rowOf(pat.id)).email === 'Pat@Acme.example', show(r));
    r = await patch(L2, pat.id, { name: '', email: '' });
    assert('blanking both name and email → 400', r.statusCode === 400 && (await rowOf(pat.id)).name === 'Patricia Jones', show(r));
    r = await patch(L2, pat.id, { phone: '', division: 'turf' });
    assert('…a phone can be cleared (a division riding in the body is fine)', r.statusCode === 200 && r.body.contact.phone === '', show(r));
    r = await patch(L2, pat.id, { supplier_name: 'Elsewhere' });
    assert('the supplier is not changed here (400 field_not_allowed) — a rename moves contacts', r.statusCode === 400 && r.body.error === 'field_not_allowed', show(r));
    r = await patch(L2, pat.id, {});
    assert('nothing to change → 400 no_fields', r.statusCode === 400 && r.body.error === 'no_fields', show(r));
    r = await patch(L2, pat.id, { name: 'n'.repeat(121) });
    assert('a 121-character name → 400', r.statusCode === 400, show(r));
    r = await patch(RIVAL, pat.id, { name: 'Rival' });
    assert('another company cannot (404)', r.statusCode === 404, show(r));
    r = await patch(ADMIN, pat.id, { name: 'Via paving' }, 'paving');
    assert('…nor through another division (404)', r.statusCode === 404, show(r));
    r = await call('PATCH', { division: 'turf' }, { name: 'x' }, L2);
    assert('no id → 400', r.statusCode === 400, show(r));

    const tab = (await liveOf('Acme Supply')).find(c => c.email === 'tab@acme.example');
    r = await del(RIVAL, tab.id);
    assert('another company cannot remove one (404)', r.statusCode === 404, show(r));
    r = await del(L2, tab.id);
    assert('a level2 removes one', r.statusCode === 200 && r.body.id === tab.id, show(r));
    const row = await rowOf(tab.id);
    assert('…softly, marked with who removed it', row.deleted_at && row.deleted_by === 's_l2');
    r = await del(L2, tab.id);
    assert('removing it again → 404', r.statusCode === 404, show(r));
    r = await patch(L2, tab.id, { name: 'Zombie' });
    assert('a removed contact cannot be changed (404)', r.statusCode === 404, show(r));
    r = await save(L2, { supplier_name: 'Acme Supply', email: 'TAB@acme.example' });
    assert('…and the same email can be saved again, as a new contact', r.statusCode === 201 && r.body.contact.id !== tab.id, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nRenaming a supplier');
  {
    const S = (body) => save(L2, { supplier_name: 'Old Co', ...body });
    const a  = (await S({ email: 'a@old.example', phone: '111' })).body.contact;
    const bo = (await S({ name: 'Bob', phone: '222' })).body.contact;
    const c  = (await S({ name: 'Cee', email: 'c@old.example' })).body.contact;
    const T = (body) => save(L2, { supplier_name: 'New Co', ...body });
    const a2 = (await T({ name: 'Alice', email: 'A@OLD.example' })).body.contact;
    const b2 = (await T({ name: 'bob' })).body.contact;
    const d  = (await T({ name: 'Dee', email: 'd@new.example' })).body.contact;
    await save(RIVAL, { supplier_name: 'Old Co', name: 'Rival Bob' });
    await save(ADMIN, { supplier_name: 'Old Co', name: 'Paving Bob' }, 'paving');
    // Procurement rows naming the supplier as their Vendor: they follow the
    // rename, or they would lose their contacts and file new ones under a
    // supplier that no longer exists.
    const prow = (id, co, division, vendor, deleted = false) => q(
      `INSERT INTO procurement_items (id, company_code, division, project_id, vendor, deleted_at) VALUES ($1, $2, $3, 'job-1', $4, $5)`,
      [id, co, division, vendor, deleted ? new Date() : null]);
    await prow('scp1', CO, 'turf', 'Old Co');
    await prow('scp2', CO, 'turf', 'OLD CO');
    await prow('scp3', CO, 'turf', 'Old Co', true);
    await prow('scp4', CO, 'turf', 'Old Co Supply');
    await prow('scp5', CO, 'paving', 'Old Co');
    await prow('scp6', CO2, 'turf', 'Old Co');
    const vendorOf = async id => (await q('SELECT vendor, version, updated_by FROM procurement_items WHERE id = $1', [id]))[0];

    let r = await rename(L3, ' old co ', 'New Co');
    assert('renaming Old Co onto New Co: one contact moved, two merged into the ones New Co already had', r.statusCode === 200
      && r.body.moved === 1 && r.body.merged === 2, show(r));
    const p1 = await vendorOf('scp1'), p2 = await vendorOf('scp2'), p3 = await vendorOf('scp3');
    assert('…and the Procurement rows naming Old Co (in any case) now name New Co, version moved, in the same request',
      r.body.rows === 3 && p1.vendor === 'New Co' && p2.vendor === 'New Co' && p1.version === 2 && p1.updated_by === 's_l3', JSON.stringify([r.body, p1, p2]));
    assert('…a deleted row too, so it comes back under the current name', p3.vendor === 'New Co');
    assert('…but not a different supplier whose name starts the same, paving\'s, or another company\'s',
      (await vendorOf('scp4')).vendor === 'Old Co Supply' && (await vendorOf('scp5')).vendor === 'Old Co' && (await vendorOf('scp6')).vendor === 'Old Co');
    const now = await liveOf('New Co');
    assert('…New Co ends with one copy of each person', JSON.stringify(now.map(x => x.id).sort()) === JSON.stringify([a2.id, b2.id, c.id, d.id].sort()),
      JSON.stringify(now.map(x => [x.name, x.email])));
    assert('…the moved one carries the new name', now.find(x => x.id === c.id).supplier_name === 'New Co');
    const A2 = await rowOf(a2.id), B2 = await rowOf(b2.id);
    assert('…a merged contact takes what it was missing, and keeps what it had', A2.name === 'Alice' && A2.phone === '111' && A2.email === 'A@OLD.example'
      && B2.name === 'bob' && B2.phone === '222', JSON.stringify([A2, B2]));
    const gone = await q('SELECT id, deleted_at, deleted_by FROM supplier_contacts WHERE id = ANY($1)', [[a.id, bo.id]]);
    assert('…the duplicates that were moving are removed softly', gone.length === 2 && gone.every(g => g.deleted_at && g.deleted_by === 's_l3'));
    assert('…Old Co has nothing left', (await liveOf('Old Co')).length === 0);
    assert('…another company\'s Old Co and paving\'s Old Co are untouched', (await liveOf('Old Co', CO2)).length === 1 && (await liveOf('Old Co', CO, 'paving')).length === 1);

    r = await rename(L2, 'New Co', 'NEW CO');
    assert('re-casing a supplier\'s name re-labels its contacts and merges nothing', r.statusCode === 200 && r.body.moved === 4 && r.body.merged === 0
      && (await liveOf('new co')).every(x => x.supplier_name === 'NEW CO'), show(r));
    assert('…and its Procurement rows\' Vendor', r.body.rows === 3 && (await vendorOf('scp1')).vendor === 'NEW CO' && (await vendorOf('scp1')).version === 3, show(r));
    r = await rename(L1, 'NEW CO', 'Newer Co');
    assert('a level1 cannot rename (403), and no row moves', r.statusCode === 403 && (await vendorOf('scp1')).vendor === 'NEW CO', show(r));
    r = await rename(L2, 'Nobody Co', 'Somebody Co');
    assert('a supplier with no contacts → moved 0', r.statusCode === 200 && r.body.moved === 0 && r.body.merged === 0, show(r));
    r = await rename(L2, 'NEW CO', '');
    assert('a blank new name → 400', r.statusCode === 400 && (await liveOf('NEW CO')).length === 4, show(r));
    r = await rename(L2, '', 'X');
    assert('a blank old name → 400', r.statusCode === 400, show(r));
    r = await rename(L2, 'NEW CO', 'n'.repeat(121));
    assert('a 121-character name → 400', r.statusCode === 400, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA rename carries the purchase orders — server-side, onto the list as stored');
  {
    const key = division => `${CO}:fct_purchase_orders:${division}`;
    const putList = (k, list) => q(`INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, JSON.stringify(list)]);
    const listOf = async k => ((await q('SELECT value FROM app_data WHERE key = $1', [k]))[0] || {}).value;
    const PO = (id, supplier, extra = {}) => ({ id, po_number: id.replace('po', 'PO-00'), title: 'Geofabric', supplier, status: 'pending',
      date_created: '2026-11-01', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', notes: '', lines: [], ...extra });
    const turfList = [
      PO('po07', 'LB Water', { lines: [
        { id: 'l1', qty: '10', unit_cost: '5', po_row_id: 'sc-dt-raised' },
        { id: 'l2', source: 'daily', qty: '3', unit_cost: '5', po_row_id: 'sc-dt-daily' }] }),
      PO('po09', 'Acme Supply', { status: 'approved', notes: 'approved by Lou' }),
      PO('po10', 'Beta Materials'),
      PO('po11', ' lb water '),
    ];
    await putList(key('turf'), turfList);
    await putList(key('paving'), [PO('po21', 'LB Water')]);
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`${CO2}:fct_purchase_orders:turf`, JSON.stringify([PO('po31', 'LB Water')])]);
    for (const [id, sup] of [['po07', 'LB Water'], ['po09', 'Acme Supply'], ['po11', ' lb water ']]) {
      await q(`INSERT INTO purchase_orders (id, company_code, division, po_num, supplier, status) VALUES ($1, $2, 'turf', $3, $4, 'pending')`, [id, CO, id, sup]);
    }
    const dt = (rowId, sup) => q(`INSERT INTO daily_tracking (row_id, company_code, division, project_id, date, supplier) VALUES ($1, $2, 'turf', 'p1', '2026-11-02', $3)`, [rowId, CO, sup]);
    await dt('sc-dt-raised', 'LB Water');
    await dt('sc-dt-daily', 'Field Pick-up');
    const stampOf = async () => (await q('SELECT updated_at::text AS t FROM app_data WHERE key = $1', [key('turf')]))[0].t;
    const stampBefore = await stampOf();
    // jsonb keeps no key order: compared with the keys sorted.
    const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));

    // A colleague approves PO-0010 and deletes PO-0011 between this
    // request's read of the list and its write: the write loses the
    // compare-and-set and is made again onto their list.
    DB.beforeCas = () => q(`UPDATE app_data SET value = $1::jsonb, updated_at = clock_timestamp() WHERE key = $2`,
      [JSON.stringify(turfList.filter(po => po.id !== 'po11').map(po => (po.id === 'po10' ? { ...po, status: 'approved' } : po))), key('turf')]);
    let r = await rename(L2, 'LB Water', 'LB Water Works');
    assert('the rename answers which purchase orders it renamed', r.statusCode === 200 && r.body.pos === 1
      && JSON.stringify(r.body.po_ids) === '["po07"]' && !r.body.po_error, show(r));
    const after = await listOf(key('turf'));
    const byId = Object.fromEntries(after.map(po => [po.id, po]));
    assert('…on the list as stored: the colleague\'s approval stands and the order they deleted stays deleted',
      byId.po10 && byId.po10.status === 'approved' && !byId.po11 && after.length === 3, JSON.stringify(after.map(po => [po.id, po.status, po.supplier])));
    assert('…the order naming it has the new Supplier, and nothing else about it changed',
      canon(byId.po07) === canon({ ...turfList[0], supplier: 'LB Water Works' }), JSON.stringify(byId.po07));
    assert('…an order naming another supplier is untouched, header and all', canon(byId.po09) === canon(turfList[1]));
    assert('…and the list\'s version moved', await stampOf() !== stampBefore);
    const mirror = Object.fromEntries((await q('SELECT id, supplier FROM purchase_orders WHERE company_code = $1', [CO])).map(x => [x.id, x.supplier]));
    assert('the normalized mirror follows for the renamed order only', mirror.po07 === 'LB Water Works' && mirror.po09 === 'Acme Supply' && mirror.po11 === ' lb water ',
      JSON.stringify(mirror));
    const rows = Object.fromEntries((await q('SELECT row_id, supplier FROM daily_tracking WHERE company_code = $1', [CO])).map(x => [x.row_id, x.supplier]));
    assert('the job cost row its own delivery made follows; the row a Daily Tracking delivery came from keeps its supplier',
      rows['sc-dt-raised'] === 'LB Water Works' && rows['sc-dt-daily'] === 'Field Pick-up', JSON.stringify(rows));
    assert('paving\'s orders and another company\'s are untouched', (await listOf(key('paving')))[0].supplier === 'LB Water'
      && (await listOf(`${CO2}:fct_purchase_orders:turf`))[0].supplier === 'LB Water');

    r = await rename(L2, 'Nobody Supply', 'Somebody Supply');
    assert('a supplier no order names: pos 0, the list not written', r.statusCode === 200 && r.body.pos === 0 && JSON.stringify(r.body.po_ids) === '[]'
      && canon(await listOf(key('turf'))) === canon(after), show(r));
    // The list keeps changing under every try: said, not silently skipped.
    DB.casLoses = true;
    r = await rename(L2, 'Acme Supply', 'Acme Supply Co');
    DB.casLoses = false;
    assert('a list that could not be written is reported (po_error busy), the rest of the rename still done', r.statusCode === 200
      && r.body.po_error === 'busy' && r.body.pos === 0 && (await listOf(key('turf'))).find(po => po.id === 'po09').supplier === 'Acme Supply', show(r));
    r = await rename(L2, 'Acme Supply', 'Acme Supply Co');
    assert('…and renaming again carries it over', r.statusCode === 200 && r.body.pos === 1
      && (await listOf(key('turf'))).find(po => po.id === 'po09').supplier === 'Acme Supply Co'
      && (await listOf(key('turf'))).find(po => po.id === 'po09').status === 'approved', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe nightly check and a database failure');
  {
    const counts = (await B.readCounts(makeSql(pool))).filter(x => x.company_code === CO);
    const turf = counts.find(x => x.measure === 'supplier_contacts.turf');
    const live = Number((await q("SELECT count(*) FROM supplier_contacts WHERE company_code = $1 AND division = 'turf' AND deleted_at IS NULL", [CO]))[0].count);
    assert('the shrink check counts the live contacts per division', turf && turf.n === live && counts.some(x => x.measure === 'supplier_contacts.paving'),
      JSON.stringify(counts.filter(x => /supplier/.test(x.measure))));
    DB.fail = true;
    const r = await list(L2);
    DB.fail = false;
    assert('a database failure is a 500 that says so, not a crash and not the driver\'s words', r.statusCode === 500
      && r.body.error === 'database_error' && !/reset/.test(JSON.stringify(r.body)), show(r));
  }

  await cleanUp();
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await pool.end(); } catch { /* already reporting the real failure */ }
  process.exit(1);
});
