#!/usr/bin/env node
'use strict';
/**
 * The Team Directory — the contact card on api/employees.js and the panel that
 * reads and writes it on divisions.html.
 *
 * Run: node scripts/test-employee-directory.js
 * No DB or server required — the neon driver and the auth module are stubbed at
 * require time, and the directory's own functions are sliced out of the page
 * and run in a real DOM.
 *
 * Three things have to hold or the directory quietly becomes wrong, and none of
 * them announces itself:
 *
 *   - a PATCH that carries a phone number must not disturb the role flags, and
 *     a PATCH that flips a flag must not blank the contact card. The two live
 *     on one row and are edited from two different screens, so a single upsert
 *     naming every column would have each save clobber the other's work.
 *   - clearing a field and not sending it are DIFFERENT. NULL is a real value
 *     for a phone number, so "leave it alone" cannot be spelled as NULL the way
 *     it can for the booleans — which is why the flags use COALESCE and the
 *     contact columns use a sent/not-sent CASE.
 *   - the roster reaches this page from four places (the employees table,
 *     paving's and kiewit's list blobs, quarry_employees). Anyone in it must be
 *     editable, and anyone in it must appear exactly once.
 *   - a division saving its employee list knows about neither the flags nor the
 *     contact card, so its write must move neither unless it says so.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');

const ADMIN  = { companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin',  isPlatformAdmin: true  };
const FIELD  = { companyCode: 'FCT', userId: 9, username: 'strickallen', role: 'level1', isPlatformAdmin: false };

let CURRENT_SQL = null;
let NEXT_AUTH   = ADMIN;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: (req, res) => {
        if (!NEXT_AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return NEXT_AUTH;
      },
      requireDivision: () => null,
      hasDivisionAccess: () => true,
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'employees.js'));
const { normalizeContact, MAX_PHONE, MAX_EMAIL } = handler._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Request / response doubles ──────────────────────────────────────────────
function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(o)   { this.body = o; return this; },
    end()     { return this; },
  };
  return res;
}

// Records every statement the handler sends, so the test can assert on the SQL
// itself — the whole point here is WHICH columns a save touches.
function recordingSql(rowsFor) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(rowsFor ? rowsFor(text, values) : []);
  };
  sql.calls = calls;
  return sql;
}

// ────────────────────────────────────────────────────────────────────────────
// 1) normalizeContact
// ────────────────────────────────────────────────────────────────────────────
function normalizeTests() {
  console.log('\n[normalizeContact]');

  assert('an absent field stays absent',
    Object.keys(normalizeContact({ is_driver: true }, 'Dale').fields).length === 0);

  assert('an empty phone clears the field',
    normalizeContact({ phone: '' }, 'Dale').fields.phone === null);
  assert('and whitespace alone is the same as empty',
    normalizeContact({ phone: '   ' }, 'Dale').fields.phone === null);

  assert('a number is stored as typed',
    normalizeContact({ phone: ' (814) 555-0142 ' }, 'Dale').fields.phone === '(814) 555-0142');
  // The office knows a man by his extension. Reformatting eats it.
  assert('an extension survives',
    normalizeContact({ phone: '814-555-0142 x12' }, 'Dale').fields.phone === '814-555-0142 x12');
  assert('a phone with no digits is refused',
    normalizeContact({ phone: 'call the shop' }, 'Dale').error != null);
  assert('an over-long phone is refused',
    normalizeContact({ phone: '5'.repeat(MAX_PHONE + 1) }, 'Dale').error != null);

  assert('an email is lower-cased and trimmed',
    normalizeContact({ email: '  Dale.Smith@ForceCorp.com ' }, 'Dale').fields.email === 'dale.smith@forcecorp.com');
  assert('an empty email clears the field',
    normalizeContact({ email: '' }, 'Dale').fields.email === null);
  assert('a name typed into the email box is refused',
    normalizeContact({ email: 'dale smith' }, 'Dale').error != null);
  assert('so is an address with no domain dot',
    normalizeContact({ email: 'dale@forcecorp' }, 'Dale').error != null);
  assert('an over-long email is refused',
    normalizeContact({ email: 'a'.repeat(MAX_EMAIL) + '@b.com' }, 'Dale').error != null);

  assert('a supervisor is trimmed',
    normalizeContact({ supervisor_name: '  Ben Hudock ' }, 'Dale').fields.supervisor_name === 'Ben Hudock');
  assert('an empty supervisor clears the field',
    normalizeContact({ supervisor_name: '' }, 'Dale').fields.supervisor_name === null);
  assert('nobody supervises themselves',
    normalizeContact({ supervisor_name: 'Dale Smith' }, 'Dale Smith').error != null);
  assert('and case or padding does not sneak it past',
    normalizeContact({ supervisor_name: '  dale smith ' }, 'Dale Smith').error != null);
}

// ────────────────────────────────────────────────────────────────────────────
// 2) PATCH — what a save actually touches
// ────────────────────────────────────────────────────────────────────────────
async function patchTests() {
  console.log('\n[PATCH — one row, two editors]');

  const savedRow = {
    id: 3, name: 'Dale Smith', is_supervisor: false, is_driver: true,
    phone: '(814) 555-0142', email: 'dale@forcecorp.com', supervisor_name: 'Ben Hudock',
  };

  async function patch(body, auth = ADMIN, name = 'Dale Smith') {
    NEXT_AUTH   = auth;
    CURRENT_SQL = recordingSql(() => [savedRow]);
    const res = mockRes();
    await handler({ method: 'PATCH', query: { name }, headers: {}, body }, res);
    return { res, sql: CURRENT_SQL };
  }

  {
    const { res, sql } = await patch({ phone: '814-555-0142', email: 'Dale@ForceCorp.com', supervisor_name: 'Ben Hudock' });
    const stmt = sql.calls[0] || { text: '', values: [] };
    assert('a contact save succeeds', res.statusCode === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    assert('and lands as one statement', sql.calls.length === 1, `${sql.calls.length} statements`);
    assert('the flags are left to COALESCE, not overwritten',
      /is_supervisor\s*=\s*COALESCE/.test(stmt.text) && /is_driver\s*=\s*COALESCE/.test(stmt.text));
    assert('and both flag parameters are null (nothing sent)',
      stmt.values.filter(v => v === true).length === 3 && stmt.values.includes(null),
      JSON.stringify(stmt.values));
    assert('the saved row comes back with the card',
      res.body.employee.phone === '(814) 555-0142' && res.body.employee.email === 'dale@forcecorp.com'
      && res.body.employee.supervisor_name === 'Ben Hudock');
  }

  {
    // The regression this whole shape exists for.
    const { res, sql } = await patch({ is_driver: true });
    const stmt = sql.calls[0];
    assert('a flag-only save still succeeds', res.statusCode === 200);
    assert('and leaves every contact column alone',
      /phone\s*=\s*CASE WHEN \?::boolean/.test(stmt.text)
      && /email\s*=\s*CASE WHEN \?::boolean/.test(stmt.text)
      && /supervisor_name\s*=\s*CASE WHEN \?::boolean/.test(stmt.text));
    assert('with all three sent-flags false',
      stmt.values.filter(v => v === false).length === 3,
      JSON.stringify(stmt.values));
  }

  {
    // Clearing is a real edit: NULL has to reach the column, which is exactly
    // what COALESCE could not express.
    const { res, sql } = await patch({ phone: '' });
    const stmt = sql.calls[0];
    assert('clearing a phone succeeds', res.statusCode === 200);
    assert('the phone sent-flag is true while the others are false',
      stmt.values.filter(v => v === true).length === 1
      && stmt.values.filter(v => v === false).length === 2,
      JSON.stringify(stmt.values));
  }

  {
    const { res, sql } = await patch({});
    assert('a save with nothing in it is refused', res.statusCode === 400, String(res.statusCode));
    assert('and nothing is written', sql.calls.length === 0);
  }

  {
    const { res, sql } = await patch({ email: 'not an address' });
    assert('a bad email is refused', res.statusCode === 400);
    assert('and nothing is written', sql.calls.length === 0);
    assert('with a reason the field can read', /email/i.test(res.body.error || ''));
  }

  {
    const { res, sql } = await patch({ supervisor_name: 'Dale Smith' });
    assert('a self-report is refused', res.statusCode === 400);
    assert('and nothing is written', sql.calls.length === 0);
  }

  {
    const { res, sql } = await patch({ phone: '814-555-0142' }, FIELD);
    assert('the field cannot edit the directory', res.statusCode === 403);
    assert('and nothing is written', sql.calls.length === 0);
  }

  {
    const { res } = await patch({ phone: '814-555-0142' }, ADMIN, '   ');
    assert('a save with no name is refused', res.statusCode === 400);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3) PUT / POST — a roster save is not a role change
// ────────────────────────────────────────────────────────────────────────────
async function rosterWriteTests() {
  console.log('\n[PUT / POST — a roster save is not a role change]');

  async function put(employees) {
    NEXT_AUTH   = ADMIN;
    CURRENT_SQL = recordingSql(text => (/SELECT name FROM employees/i.test(text) ? [] : []));
    const res = mockRes();
    await handler({ method: 'PUT', query: {}, headers: {}, body: { employees } }, res);
    // The first statement is the existing-names read; the upserts follow.
    return { res, upserts: CURRENT_SQL.calls.filter(c => /INSERT INTO employees/i.test(c.text)) };
  }

  {
    const { res, upserts } = await put([{ name: 'Dale Smith', job_class: 'Foreman' }]);
    assert('a roster save succeeds', res.statusCode === 200 && res.body.ok === true);
    assert('and upserts the person', upserts.length === 1);
    // The bug: EXCLUDED.is_supervisor sends whatever the VALUES list carried,
    // and a payload with no flag in it carried FALSE — so saving an employee
    // list un-flagged every supervisor in the company.
    assert('the flag is left to COALESCE, not to EXCLUDED',
      /is_supervisor\s*=\s*COALESCE\(\?::boolean, employees\.is_supervisor\)/.test(upserts[0].text)
      && !/is_supervisor\s*=\s*EXCLUDED/.test(upserts[0].text),
      upserts[0].text.match(/is_supervisor[^,]*/)[0]);
    assert('and the parameter is null, meaning "not sent"',
      upserts[0].values.includes(null));
    assert('the columns it does own still come from EXCLUDED',
      /job_class\s*=\s*EXCLUDED/.test(upserts[0].text)
      && /pw_rate\s*=\s*EXCLUDED/.test(upserts[0].text)
      && /sort_order\s*=\s*EXCLUDED/.test(upserts[0].text));
    assert('and the contact card is not named at all',
      !/\bphone\b/.test(upserts[0].text) && !/\bemail\b/.test(upserts[0].text)
      && !/supervisor_name/.test(upserts[0].text));
  }

  {
    // Absent must not become "ignored" — is_supervisor is in the PUT contract.
    const { upserts } = await put([
      { name: 'Ben Hudock',  is_supervisor: true },
      { name: 'Dale Smith',  is_supervisor: false },
      { name: 'Paving Pete' },
    ]);
    assert('a sent true reaches the statement',  upserts[0].values.includes(true));
    assert('a sent false reaches it too',        upserts[1].values.includes(false));
    assert('and an absent flag stays null',      upserts[2].values.includes(null));
  }

  {
    // POST upserts by name, so it needs the same rule.
    NEXT_AUTH   = ADMIN;
    CURRENT_SQL = recordingSql(() => [{ id: 1, name: 'Dale Smith', is_supervisor: true }]);
    const res = mockRes();
    await handler({ method: 'POST', query: {}, headers: {}, body: { name: 'Dale Smith', job_class: 'Foreman' } }, res);
    const stmt = CURRENT_SQL.calls[0];
    assert('a POST succeeds', res.statusCode === 201, String(res.statusCode));
    assert('and leaves an unmentioned flag to COALESCE',
      /is_supervisor\s*=\s*COALESCE\(\?::boolean, employees\.is_supervisor\)/.test(stmt.text)
      && stmt.values.includes(null));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4) GET — everyone on the roster, from wherever they were entered
// ────────────────────────────────────────────────────────────────────────────
async function getTests() {
  console.log('\n[GET — the merged roster]');

  NEXT_AUTH = ADMIN;
  CURRENT_SQL = recordingSql((text) => {
    if (/FROM\s+employees/i.test(text)) {
      return [{
        id: 3, name: 'Dale Smith', job_class: 'Operator',
        prevailing_rate: null, non_prevailing_rate: null,
        is_supervisor: false, is_driver: true,
        phone: '(814) 555-0142', email: 'dale@forcecorp.com', supervisor_name: 'Ben Hudock',
        sort_order: 0,
      }];
    }
    if (/fct_paving_lists/.test(text) || /app_data/.test(text)) {
      return [{ value: { employees: [{ name: 'Paving Pete' }] } }];
    }
    if (/quarry_employees/i.test(text)) return [{ name: 'Quarry Quinn' }];
    return [];
  });

  const res = mockRes();
  await handler({ method: 'GET', query: {}, headers: {}, body: null }, res);

  const list = (res.body && res.body.employees) || [];
  const byName = Object.fromEntries(list.map(e => [e.name, e]));

  assert('the contact card is selected', /\bphone\b/.test(CURRENT_SQL.calls[0].text)
    && /\bemail\b/.test(CURRENT_SQL.calls[0].text)
    && /supervisor_name/.test(CURRENT_SQL.calls[0].text));
  assert('a table employee carries their card',
    byName['Dale Smith'] && byName['Dale Smith'].phone === '(814) 555-0142'
    && byName['Dale Smith'].email === 'dale@forcecorp.com'
    && byName['Dale Smith'].supervisor_name === 'Ben Hudock');
  // Blob-only people must still SHOW, with an empty card the directory can
  // fill in — a PATCH creates their row on the first save.
  assert('a paving-only employee appears with an empty card',
    byName['Paving Pete'] && byName['Paving Pete'].phone === null
    && byName['Paving Pete'].email === null
    && byName['Paving Pete'].supervisor_name === null);
  assert('so does a quarry-only employee',
    byName['Quarry Quinn'] && byName['Quarry Quinn'].supervisor_name === null);
  assert('and nobody is listed twice',
    new Set(list.map(e => e.name)).size === list.length);
}

// ────────────────────────────────────────────────────────────────────────────
// 5) The panel on divisions.html
// ────────────────────────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'divisions.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));

function sliceDirectory() {
  const start = SCRIPT.indexOf('// ── Team Directory ─');
  const end   = SCRIPT.indexOf('// ── Sign out ─');
  if (start < 0 || end < 0) throw new Error('could not find the Team Directory block in divisions.html');
  const esc = /function escHtml\(s\) \{[\s\S]*?\n {4}\}/.exec(SCRIPT);
  if (!esc) throw new Error('could not find escHtml in divisions.html');
  return esc[0] + '\n' + SCRIPT.slice(start, end);
}

function structuralTests() {
  console.log('\n[structural — the welcome screen]');

  const dom  = new JSDOM(PAGE);
  const doc  = dom.window.document;
  const entry = doc.getElementById('directoryLink');

  assert('the welcome screen carries a directory entry', !!entry);
  assert('and it sits inside the welcome block, under the sub-line',
    !!entry && !!entry.closest('.welcome'));
  assert('it is quiet — no card, no badge, just a labelled control',
    !!entry && /team directory/i.test(entry.textContent) && entry.tagName === 'BUTTON');
  assert('and it opens the directory', !!entry && /openDirectory\(\)/.test(entry.getAttribute('onclick') || ''));

  const modal = doc.getElementById('dirModalBackdrop');
  assert('the directory modal ships with the page', !!modal);
  assert('and starts closed', !!modal && !modal.classList.contains('open'));

  const heads = Array.from(doc.querySelectorAll('.dir-table thead th')).map(th => th.textContent.trim());
  assert('it holds name, cell, email and supervisor',
    heads[0] === 'Name' && /cell/i.test(heads[1]) && /email/i.test(heads[2]) && /supervisor/i.test(heads[3]),
    heads.join(' | '));
  assert('the empty-state row spans every column',
    (doc.querySelector('#dirListBody td') || {}).getAttribute &&
    doc.querySelector('#dirListBody td').getAttribute('colspan') === String(heads.length));
  assert('a supervisor datalist backs the editor', !!doc.getElementById('dirSupervisorNames'));
  assert('Escape and a backdrop click both close it',
    /dirModalBackdrop'\)\.classList\.contains\('open'\)\) closeDirectory\(\)/.test(SCRIPT)
    && /getElementById\('dirModalBackdrop'\)\.addEventListener\('click'/.test(SCRIPT));
}

// Builds a live directory panel: the real markup, the real functions, a stubbed
// roster and a stubbed fetch.
function buildPanel({ admin = true, roster = [], fetchImpl = null } = {}) {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    var token = 'test-token';
    var user  = { username: 'hudockben', role: '${admin ? 'admin' : 'level1'}', companyCode: 'FCT', companyName: 'Force Corp' };
    var isPlatformAdmin = ${admin ? 'true' : 'false'};
    var _downloadXlsx = function (sheets, filename) { w_lastExport = { sheets: sheets, filename: filename }; };
    var _todayStamp   = function () { return '2026-09-09'; };
    var w_lastExport  = null;
  `);
  w.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ employees: roster }) }));
  w.eval(sliceDirectory());
  return { dom, w };
}

async function behaviourTests() {
  console.log('\n[behavioural — the directory panel]');

  const ROSTER = [
    { name: 'Ben Hudock', phone: '',                 email: 'ben@forcecorp.com', supervisor_name: '',           is_supervisor: true,  is_driver: false },
    { name: 'Dale Smith', phone: '(814) 555-0142',   email: '',                  supervisor_name: 'Ben Hudock', is_supervisor: false, is_driver: true  },
    { name: 'Paving Pete', phone: null,              email: null,                supervisor_name: null,         is_supervisor: false, is_driver: false },
    { name: 'Quarry Quinn', phone: '814.555.9000',   email: 'quinn@forcecorp.com', supervisor_name: 'Dale Smith', is_supervisor: false, is_driver: false },
  ];

  // ── admin view ──
  {
    const { w } = buildPanel({ admin: true, roster: ROSTER });
    await w.eval('openDirectory()');
    const doc  = w.document;
    const rows = () => Array.from(doc.querySelectorAll('#dirListBody tr'));

    assert('opening the directory opens the modal',
      doc.getElementById('dirModalBackdrop').classList.contains('open'));
    assert('everyone on the roster is listed once', rows().length === 4, `${rows().length} rows`);
    assert('the count names the people and the numbers held',
      /4 people/.test(doc.getElementById('dir-count').textContent)
      && /2 with a cell number/.test(doc.getElementById('dir-count').textContent),
      doc.getElementById('dir-count').textContent);

    const dale = rows()[1];
    assert('a cell number is dialable',
      (dale.querySelector('a[href^="tel:"]') || {}).getAttribute
      && dale.querySelector('a[href^="tel:"]').getAttribute('href') === 'tel:8145550142',
      dale.innerHTML);
    assert('and shows as it was typed',
      /\(814\) 555-0142/.test(dale.textContent));
    assert('an email is a mailto link',
      rows()[0].querySelector('a[href="mailto:ben@forcecorp.com"]') !== null);
    assert('a missing field reads as a dash, not a blank',
      rows()[2].querySelectorAll('.dir-blank').length === 3);
    assert('the supervisor is shown on the person who reports to them',
      /Ben Hudock/.test(dale.querySelector('[data-col="sup"]').textContent));
    assert('role badges come along', rows()[0].querySelector('.dir-tag.sup') !== null
      && rows()[1].querySelector('.dir-tag.drv') !== null);
    assert('an admin gets an edit control on every row',
      rows().every(r => r.querySelector('.user-edit-btn')));

    // Search
    doc.getElementById('dir-search').value = 'quarry';
    w.eval('renderDirectory()');
    assert('search finds a name', rows().length === 1 && /Quarry Quinn/.test(rows()[0].textContent));

    // Searching a supervisor's name is how you pull up a crew, so it matches
    // the man himself AND everyone who reports to him.
    doc.getElementById('dir-search').value = 'hudock';
    w.eval('renderDirectory()');
    assert('searching a supervisor pulls up their crew with them',
      rows().length === 2 && /Ben Hudock/.test(rows()[0].textContent)
      && /Dale Smith/.test(rows()[1].textContent), `${rows().length} rows`);

    doc.getElementById('dir-search').value = '8145550142';
    w.eval('renderDirectory()');
    assert('and finds a formatted number typed as bare digits',
      rows().length === 1 && /Dale Smith/.test(rows()[0].textContent), `${rows().length} rows`);

    doc.getElementById('dir-search').value = 'quinn@forcecorp.com';
    w.eval('renderDirectory()');
    assert('and finds an email address', rows().length === 1);
    doc.getElementById('dir-search').value = '';

    // Supervisor filter — the "who reports to whom" read.
    const sel = doc.getElementById('dir-filter-sup');
    const opts = Array.from(sel.options).map(o => o.value);
    assert('the supervisor filter offers the flagged supervisor', opts.includes('Ben Hudock'));
    assert('and anyone already named as one, flagged or not', opts.includes('Dale Smith'),
      opts.join(' | '));
    assert('plus a way to find the people with nobody set', opts.includes('__none__'));

    sel.value = 'Ben Hudock';
    w.eval('renderDirectory()');
    assert('filtering by supervisor shows their reports',
      rows().length === 1 && /Dale Smith/.test(rows()[0].textContent));

    sel.value = '__none__';
    w.eval('renderDirectory()');
    assert('and the no-supervisor filter finds the gaps',
      rows().length === 2, `${rows().length} rows`);
    sel.value = '';
    w.eval('renderDirectory()');

    // Export
    w.eval('exportDirectoryXlsx()');
    const exp = w.eval('w_lastExport');
    assert('the export names the file for the company and the day',
      exp && exp.filename === 'force-corp-team-directory-2026-09-09.xlsx', exp && exp.filename);
    assert('and carries the card, not just the names',
      exp.sheets[0].header.join(',') === 'Name,Cell Phone,Email,Reports To,Supervisor,Driver');
    assert('with one row per person shown', exp.sheets[0].rows.length === 4);
  }

  // ── editing ──
  {
    let sent = null;
    const fetchImpl = async (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        sent = { url, body: JSON.parse(opts.body) };
        return {
          ok: true,
          json: async () => ({ ok: true, employee: {
            name: 'Paving Pete', phone: '(814) 555-7788',
            email: 'pete@forcecorp.com', supervisor_name: 'Ben Hudock',
          } }),
        };
      }
      return { ok: true, json: async () => ({ employees: ROSTER }) };
    };
    const { w } = buildPanel({ admin: true, roster: ROSTER, fetchImpl });
    await w.eval('openDirectory()');
    const doc = w.document;

    const pete = Array.from(doc.querySelectorAll('#dirListBody tr'))[2];
    // Inline onclick attributes are not compiled under runScripts:'outside-only',
    // so the handler is called the way the attribute would call it.
    assert('the edit control is wired to the row it sits in',
      /dirEdit\(this\)/.test(pete.querySelector('.user-edit-btn').getAttribute('onclick'))
      && pete.querySelector('.user-edit-btn').dataset.dirName === 'Paving Pete');
    w.eval('dirEdit(document.querySelectorAll("#dirListBody .user-edit-btn")[2])');

    assert('editing a row opens the three fields in place',
      !!doc.getElementById('dir-edit-phone') && !!doc.getElementById('dir-edit-email')
      && !!doc.getElementById('dir-edit-sup'));
    assert('the supervisor field is backed by the suggestion list',
      doc.getElementById('dir-edit-sup').getAttribute('list') === 'dirSupervisorNames');
    assert('only the edited row is open',
      doc.querySelectorAll('#dirListBody tr.editing').length === 1);

    doc.getElementById('dir-edit-phone').value = '814-555-7788';
    doc.getElementById('dir-edit-email').value = 'Pete@ForceCorp.com';
    doc.getElementById('dir-edit-sup').value   = 'Ben Hudock';
    await w.eval('dirSave(document.getElementById("dir-save-btn"))');

    assert('saving PATCHes that one person by name',
      sent && /\/api\/employees\?name=Paving%20Pete$/.test(sent.url), sent && sent.url);
    assert('and sends all three fields in one request',
      sent && sent.body.phone === '814-555-7788'
      && sent.body.email === 'Pete@ForceCorp.com'
      && sent.body.supervisor_name === 'Ben Hudock');
    assert('it never sends the role flags, which it does not own',
      sent && !('is_supervisor' in sent.body) && !('is_driver' in sent.body));

    const row = Array.from(doc.querySelectorAll('#dirListBody tr'))[2];
    assert('the row closes and shows what the server stored',
      doc.querySelectorAll('#dirListBody tr.editing').length === 0
      && /\(814\) 555-7788/.test(row.textContent)
      && /pete@forcecorp\.com/.test(row.textContent));
    assert('and the save is confirmed',
      /Saved Paving Pete/.test(doc.getElementById('dir-status').textContent));
    assert('a newly named supervisor joins the filter without a reload',
      Array.from(doc.getElementById('dir-filter-sup').options).map(o => o.value).includes('Ben Hudock'));
  }

  // ── a rejected save keeps the typing ──
  {
    const fetchImpl = async (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        return { ok: false, json: async () => ({ error: 'email is not a valid address' }) };
      }
      return { ok: true, json: async () => ({ employees: ROSTER }) };
    };
    const { w } = buildPanel({ admin: true, roster: ROSTER, fetchImpl });
    await w.eval('openDirectory()');
    const doc = w.document;
    w.eval('dirEdit(document.querySelectorAll("#dirListBody .user-edit-btn")[0])');
    doc.getElementById('dir-edit-email').value = 'not an address';
    await w.eval('dirSave(document.getElementById("dir-save-btn"))');

    assert('a refused save says why',
      /not a valid address/.test(doc.getElementById('dir-status').textContent),
      doc.getElementById('dir-status').textContent);
    assert('the row stays open so nothing typed is lost',
      doc.querySelectorAll('#dirListBody tr.editing').length === 1
      && doc.getElementById('dir-edit-email').value === 'not an address');
    assert('and the Save button is usable again',
      doc.getElementById('dir-save-btn').disabled === false);
  }

  // ── the field crew ──
  {
    const { w } = buildPanel({ admin: false, roster: ROSTER });
    await w.eval('openDirectory()');
    const doc = w.document;
    assert('a non-admin still gets the whole directory',
      doc.querySelectorAll('#dirListBody tr').length === 4);
    assert('but no edit controls',
      doc.querySelectorAll('#dirListBody .user-edit-btn').length === 0);
    assert('and the note says who maintains it',
      /administrator/i.test(doc.getElementById('dir-note').textContent));
  }

  // ── an empty roster ──
  {
    const { w } = buildPanel({ admin: true, roster: [] });
    await w.eval('openDirectory()');
    const doc = w.document;
    assert('an empty roster says so rather than showing a blank table',
      /No employees on the roster yet/.test(doc.getElementById('dirListBody').textContent));
  }

  // ── a roster that will not load ──
  {
    const fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'Database error' }) });
    const { w } = buildPanel({ admin: true, fetchImpl });
    await w.eval('openDirectory()');
    assert('a failed load surfaces the error in the table',
      /Database error/.test(w.document.getElementById('dirListBody').textContent));
  }
}

// ────────────────────────────────────────────────────────────────────────────
(async () => {
  normalizeTests();
  await patchTests();
  await rosterWriteTests();
  await getTests();
  structuralTests();
  await behaviourTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
