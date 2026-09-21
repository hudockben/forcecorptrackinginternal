#!/usr/bin/env node
'use strict';
/**
 * Does the page actually come up?
 *
 * Run: node scripts/test-page-boot.js
 *
 * check-html-syntax.js PARSES every inline script; it does not RUN one. That
 * gap has a shape, and the Scheduler fell straight into it: a pair of handlers
 * were renamed, the Object.assign(window, {...}) list at the foot of the file
 * kept pointing at the old names, and referencing a name that no longer exists
 * throws while the script is still evaluating. Everything after it — the drag
 * wiring, loadAll() — never ran. The page parsed perfectly and sat on
 * "Loading master schedule…" forever, and every unit test still passed,
 * because each of those lifts one function out of the file and never asks
 * whether the file as a whole can be loaded.
 *
 * So this runs the page: a real DOM, the session seeded so it does not bounce
 * to the login screen, fetch stubbed so nothing leaves the process. Then it
 * asks the only question that matters — did anything throw, and did the boot
 * reach the end of the script.
 *
 * It is deliberately shallow. It is not about what the page renders; the other
 * suites cover that. It is about the class of failure where the page does not
 * render AT ALL.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '\n      ' + String(detail).split('\n').slice(0, 4).join('\n      ') : ''}`); }
}

// The pages this suite covers. Each is a division screen behind the same
// login, so one seeded session boots them all.
// `placeholder` is the text the page ships in its markup and replaces once it
// has loaded. A page whose script died part-way still SHOWS it, which is
// precisely what the Scheduler did, so clearing it is the honest proof that
// the boot ran to the end. Hoisting is why a weaker check does not do: a
// top-level `function foo(){}` is on window even when execution threw before
// reaching it, so asking whether the handlers exist proves nothing.
const PAGES = [
  { file: 'scheduler.html',       placeholder: 'Loading master schedule' },
  { file: 'tracker.html',         placeholder: null },
  { file: 'paving.html',          placeholder: null },
  { file: 'kiewit-pinetree.html', placeholder: null },
  { file: 'divisions.html',       placeholder: null },
];

const SESSION = {
  fct_token: 'harness',
  fct_user: JSON.stringify({
    userId: 1, username: 'harness', companyCode: 'FCT', isPlatformAdmin: true,
    divisionRoles: { turf:'level5', paving:'level5', kiewit:'level5', scheduler:'level5', safety:'level3' },
  }),
  fct_division: 'turf',
};

function boot(file) {
  const html = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  // A page that reaches for a name that is not there surfaces here.
  vc.on('jsdomError', e => {
    // Navigation is not implemented in jsdom; a page choosing to redirect is
    // not a boot failure, and is reported separately below.
    if (/Not implemented: navigation/i.test(e.message || '')) { errors.navigated = true; return; }
    errors.push(e.message + (e.detail ? '\n' + e.detail : ''));
  });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://datawatch.app/' + file,
    virtualConsole: vc,
    beforeParse(w) {
      try { Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v)); } catch {}
      // Nothing leaves the process. Every endpoint answers the shape the
      // pages expect of a successful-but-empty response.
      w.fetch = () => Promise.resolve({
        ok: true, status: 200,
        json:  async () => ({ ok: true, value: null, user: null, employees: [], jobs: [], entries: [], rows: [], groups: [] }),
        text:  async () => '',
      });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {};
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  return { dom, errors };
}

(async () => {
  console.log('Does the page actually come up?\n');

  for (const { file, placeholder } of PAGES) {
    console.log(`[${file}]`);
    let r;
    try { r = boot(file); }
    catch (err) { assert('  the page loads', false, err.message); console.log(''); continue; }

    // Let the deferred work and the async boot settle.
    await new Promise(res => setTimeout(res, 250));

    assert('  nothing throws while the script evaluates', r.errors.length === 0, r.errors[0]);

    if (placeholder) {
      const shown = (r.dom.window.document.body.textContent || '');
      assert(`  it gets past "${placeholder}\u2026"`, !shown.includes(placeholder),
        'the page is still showing its loading placeholder \u2014 the script did not reach the end');
    }

    r.dom.window.close();
    console.log('');
  }

  // The specific trap: a name exported to window that no longer exists. Static,
  // so it names the offender rather than just failing to boot.
  console.log('[nothing is exported to window that no longer exists]');
  {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'scheduler.html'), 'utf8');
    const m = src.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\s*\)/);
    assert('  the export list is found', !!m);
    if (m) {
      const names = m[1].split(',').map(s => s.trim()).filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
      const missing = names.filter(n =>
        !new RegExp(`(function\\s+${n}\\s*\\(|const\\s+${n}\\s*=|let\\s+${n}\\s*=|var\\s+${n}\\s*=)`).test(src));
      assert(`  all ${names.length} exported names are declared in the page`,
        missing.length === 0, 'missing: ' + missing.join(', '));
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
