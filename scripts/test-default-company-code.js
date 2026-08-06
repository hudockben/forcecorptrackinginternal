#!/usr/bin/env node
'use strict';
/**
 * Tests for the injected company code — the sign-in field nobody should have
 * to type on a single-tenant deployment.
 *
 * Run: node scripts/test-default-company-code.js
 *
 * Two layers:
 *   1. api/auth/login.js — companyCode becomes optional when the deployment
 *      sets DEFAULT_COMPANY_CODE. This is the layer that matters: a browser
 *      holding a cached copy of the old index.html, or any direct caller,
 *      still signs in. An explicit code in the body must keep winning, or
 *      a second company silently lands in the first company's data.
 *   2. index.html — structural checks that the page injects a code, hides
 *      the field, and can still put it back. The escape hatches are the
 *      easiest thing to drop in a later edit and the hardest to notice,
 *      since the happy path keeps working without them.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ─────────────────────────────────────────────────────────────────────
// 1) api/auth/login.js — DEFAULT_COMPANY_CODE fallback
// ─────────────────────────────────────────────────────────────────────

// Every query the handler runs, captured so the assertions can read back
// which company code actually reached SQL.
let queries = [];

const orig = Module._load;
Module._load = function (req, parent) {
  if (req === '@neondatabase/serverless') {
    return { neon: () => (strings, ...vals) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      queries.push({ q, vals });
      // autoSyncIfNeeded's guard — a row here makes it return before it
      // touches anything else, so the fire-and-forget path stays quiet.
      if (/SELECT 1 FROM projects/.test(q)) return Promise.resolve([{ '?column?': 1 }]);
      if (/FROM users u/.test(q)) {
        const code = String(vals[1] || '').toUpperCase();
        if (code !== 'FORCECORP' && code !== 'OTHERCO') return Promise.resolve([]);
        return Promise.resolve([{
          id: 7,
          username: 'hudockben',
          password_hash: 'hash:letmein',
          role: 'admin',
          divisions: null,
          division_roles: null,
          is_platform_admin: true,
          company_name: code === 'FORCECORP' ? 'Force Corp' : 'Other Co',
          allowed_divisions: ['turf'],
        }]);
      }
      return Promise.resolve([]);
    } };
  }
  if (req === 'bcryptjs')     return { compare: async (pw, hash) => hash === 'hash:' + pw };
  if (req === 'jsonwebtoken') return { sign: (payload) => 'jwt:' + JSON.stringify(payload) };
  if (/sync-normalized$/.test(req)) {
    return {
      syncProjects: async () => {}, syncLists: async () => {},
      syncPurchaseOrders: async () => {}, syncInventory: async () => {},
    };
  }
  return orig.apply(this, arguments);
};

const login = require(path.resolve(__dirname, '../api/auth/login.js'));
Module._load = orig;

// Minimal Vercel-style res. Resolves once the handler answers, so a test can
// await the response without racing the fire-and-forget backfill.
function call(body, envDefault) {
  queries = [];
  if (envDefault === undefined) delete process.env.DEFAULT_COMPANY_CODE;
  else process.env.DEFAULT_COMPANY_CODE = envDefault;

  return new Promise((resolve) => {
    let code = 200;
    const res = {
      setHeader() {},
      status(c) { code = c; return res; },
      json(payload) { resolve({ code, payload }); return res; },
      end() { resolve({ code, payload: null }); return res; },
    };
    login({ method: 'POST', body, headers: {} }, res);
  });
}

// The company code the users lookup was actually scoped to.
function queriedCode() {
  const hit = queries.find(x => /FROM users u/.test(x.q));
  return hit ? String(hit.vals[1]) : null;
}

async function loginTests() {
  console.log('\n[api/auth/login.js]');

  let r = await call({ username: 'hudockben', password: 'letmein' }, 'FORCECORP');
  assert('body without companyCode signs in when the env default is set',
    r.code === 200 && r.payload && r.payload.ok === true, `got ${r.code}`);
  assert('  lookup is scoped to the default code',
    queriedCode() === 'FORCECORP', `queried ${queriedCode()}`);
  assert('  session carries the default code',
    r.payload && r.payload.user && r.payload.user.companyCode === 'FORCECORP');

  r = await call({ username: 'hudockben', password: 'letmein' }, undefined);
  assert('body without companyCode is still rejected with no env default',
    r.code === 400, `got ${r.code}`);
  assert('  and never reaches the users table',
    queriedCode() === null);

  // The whole point of keeping the field in the DOM: OTHERCO must not be
  // rewritten to the default just because a default exists.
  r = await call({ companyCode: 'OTHERCO', username: 'hudockben', password: 'letmein' }, 'FORCECORP');
  assert('explicit companyCode overrides the env default',
    r.code === 200 && queriedCode() === 'OTHERCO', `queried ${queriedCode()}`);
  assert('  session carries the explicit code',
    r.payload && r.payload.user && r.payload.user.companyCode === 'OTHERCO');

  // An empty string is what a hidden-but-submitted field sends. It must fall
  // through to the default rather than 400 or query for ''.
  r = await call({ companyCode: '', username: 'hudockben', password: 'letmein' }, 'FORCECORP');
  assert('empty companyCode falls through to the env default',
    r.code === 200 && queriedCode() === 'FORCECORP', `queried ${queriedCode()}`);

  r = await call({ companyCode: '  forcecorp  ', username: 'hudockben', password: 'letmein' }, undefined);
  assert('surrounding whitespace is trimmed before the lookup',
    r.code === 200 && queriedCode() === 'forcecorp', `queried ${queriedCode()}`);
  assert('  and the session code is upper-cased',
    r.payload && r.payload.user && r.payload.user.companyCode === 'FORCECORP');

  // A non-string body value used to reach .trim() and throw a 500.
  r = await call({ companyCode: 12345, username: 'hudockben', password: 'letmein' }, 'FORCECORP');
  assert('a non-string companyCode is coerced, not a 500',
    r.code === 401, `got ${r.code}`);

  r = await call({ username: 'hudockben', password: 'wrong' }, 'FORCECORP');
  assert('the default does not weaken the password check',
    r.code === 401, `got ${r.code}`);

  r = await call({ username: 'hudockben' }, 'FORCECORP');
  assert('a missing password is still a 400',
    r.code === 400, `got ${r.code}`);

  r = await call({ username: 'hudockben', password: 'letmein' }, 'NOSUCHCO');
  assert('an unknown default still 401s rather than signing anyone in',
    r.code === 401, `got ${r.code}`);
}

// ─────────────────────────────────────────────────────────────────────
// 2) index.html — structural wiring
// ─────────────────────────────────────────────────────────────────────

function pageChecks() {
  console.log('\n[index.html]');
  const src = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

  assert('injects window.DEFAULT_COMPANY_CODE',
    /window\.DEFAULT_COMPANY_CODE\s*=\s*'[^']*'/.test(src));
  assert('the injected value is non-empty',
    /window\.DEFAULT_COMPANY_CODE\s*=\s*'[^']+'/.test(src));
  assert('reads it into INJECTED_CODE, upper-cased',
    /INJECTED_CODE\s*=\s*String\(window\.DEFAULT_COMPANY_CODE[^)]*\)[\s\S]{0,40}toUpperCase\(\)/.test(src));

  assert('the company field is still in the DOM',
    /id="companyField"/.test(src) && /id="companyCode"/.test(src));
  assert('pinCompanyCode hides the field and drops required',
    /function pinCompanyCode[\s\S]{0,320}hidden\s*=\s*true[\s\S]{0,200}required\s*=\s*false/.test(src));
  assert('revealCompanyField puts it back and restores required',
    /function revealCompanyField[\s\S]{0,320}hidden\s*=\s*false[\s\S]{0,200}required\s*=\s*true/.test(src));

  // Escape hatches — each one is the only way out of a wrong pinned code.
  assert('?company= overrides the injected code',
    /URLSearchParams\(location\.search\)\.get\('company'\)/.test(src));
  assert('the injected code outranks the remembered one',
    /get\('company'\)[\s\S]{0,80}INJECTED_CODE[\s\S]{0,120}getItem\('fct_company_code'\)/.test(src));
  assert('a toggle reveals the field on demand',
    /id="companyToggle"/.test(src) &&
    /companyToggle\.addEventListener\('click'[\s\S]{0,120}revealCompanyField\(\)/.test(src));
  assert('a 401 against a hidden field reveals it',
    /res\.status === 401 && companyField\.hidden\)\s*revealCompanyField\(\)/.test(src));

  assert('submit falls back to the injected code',
    /companyInput\.value\.trim\(\)\s*\|\|\s*INJECTED_CODE/.test(src));
  assert('submit still sends companyCode to the API',
    /JSON\.stringify\(\{\s*companyCode,\s*username,\s*password\s*\}\)/.test(src));
  assert('an empty code with nothing injected reveals the field instead of posting',
    /if \(!companyCode\) \{[\s\S]{0,120}revealCompanyField\(\);[\s\S]{0,120}return;/.test(src));
  assert('a successful sign-in remembers the code',
    /setItem\('fct_company_code',\s*data\.user\.companyCode\)/.test(src));
  assert('the pinned workspace is shown rather than hidden outright',
    /workspaceTag\.textContent\s*=\s*'--workspace=' \+ code/.test(src));
  assert('the toggle has a display rule for [hidden]',
    /\.co-toggle\[hidden\]\s*\{\s*display:\s*none/.test(src));
}

(async () => {
  await loginTests();
  pageChecks();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
