#!/usr/bin/env node
'use strict';
/**
 * The email address check (api/lib/email.js isValidEmail, and its copy in
 * report-email.js).
 *
 * Run: node scripts/test-email-address-check.js
 *
 * Resend refuses a whole send when one address on it is malformed: a
 * recipient group holding "abotsford@forcecorporation..com" sent the Safety
 * Sign-Off Report to none of its nine people. The check turns such addresses
 * away where they can be named, and must not turn away anything the old,
 * looser check let through and the mail service takes.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { isValidEmail } = require(path.join(ROOT, 'api/lib/email.js'));
const OLD_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 300) : '')); }
};

const GOOD = [
  'bhudock@forcecorporation.com', 'abotsford@forcecorporation.com', 'a@b.co',
  'john.smith@forcecorp.com', 'john+safety@forcecorp.com', 'john_smith@forcecorp.com',
  'john-smith@forcecorp.com', '-john@forcecorp.com', 'john%x@forcecorp.com',
  'pm@mail.forcecorp.co.uk', 'pm@force-corp.com', 'pm@f.com', 'PM@Example.COM',
  '1234@567.org', 'a'.repeat(64) + '@x.com', 'pm@' + 'a'.repeat(63) + '.com',
  'x@' + Array(8).fill('a'.repeat(30)).join('.') + '.com',
];
const BAD = [
  'abotsford@forcecorporation..com',   // the one that stopped the Safety Sign-Off Report
  'john..smith@forcecorp.com', '.john@forcecorp.com', 'john.@forcecorp.com',
  'john@.forcecorp.com', 'john@forcecorp.com.', 'john@-forcecorp.com', 'john@forcecorp-.com',
  'john@forcecorp.c', 'john@forcecorp', 'john@forcecorp,com', 'john@@forcecorp.com',
  'john smith@forcecorp.com', 'John Smith <john@forcecorp.com>', 'mailto:john@forcecorp.com',
  "o'brien@forcecorp.com", 'jöhn@forcecorp.com', '​john@forcecorp.com', '@forcecorp.com', 'john@', '',
  'a'.repeat(65) + '@x.com', 'pm@' + 'a'.repeat(64) + '.com', 'pm@x.' + 'c'.repeat(64),
  'x@' + Array(9).fill('a'.repeat(30)).join('.') + '.com',   // 285 characters
  null, undefined, 42, {},
];

console.log('Addresses people use');
for (const e of GOOD) ok(`takes ${e.length > 40 ? e.slice(0, 37) + '…' : e}`, isValidEmail(e));
ok('…with spaces around it', isValidEmail('  pm@forcecorp.com \n'));

console.log('\nAddresses the mail service refuses');
for (const e of BAD) ok(`turns away ${JSON.stringify(typeof e === 'string' && e.length > 40 ? e.slice(0, 37) + '…' : e)}`, !isValidEmail(e));

console.log('\nNothing newly let through');
// Every address it takes, the old check took: the new one only narrows.
const parts = ['a', 'Z9', '.', '..', '-', '_', '%', '+', '@', 'x', 'co', 'com', '-x', 'x-'];
let tried = 0, widened = [];
for (let n = 0; n < 40000; n++) {
  let s = '';
  let k = n;
  do { s += parts[k % parts.length]; k = Math.floor(k / parts.length); } while (k);
  for (const cand of [s, s + '.com', 'pm@' + s, s + '@x.com']) {
    tried++;
    if (isValidEmail(cand) && !OLD_RE.test(cand)) widened.push(cand);
  }
}
ok(`of ${tried} made-up strings, none it takes that the old check refused`, widened.length === 0, widened.slice(0, 5).join(', '));
ok('…and the samples above agree', GOOD.every(e => OLD_RE.test(e.trim())));

console.log('\nThe Email Report modal checks the same way');
const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
const lib = fs.readFileSync(path.join(ROOT, 'api/lib/email.js'), 'utf8');
const reOf = text => (text.match(/const EMAIL_RE = (\/.+\/[a-z]*);/) || [])[1];
ok('report-email.js carries the server\'s pattern, character for character', reOf(src) && reOf(src) === reOf(lib),
  `${reOf(src)}\n${reOf(lib)}`);

console.log('\nFast on whatever is pasted');
const hostile = [
  'a'.repeat(5000) + '@', 'a.'.repeat(3000) + '@x.com', 'x@' + 'a-'.repeat(3000) + '.com',
  'x@' + 'a.'.repeat(3000), 'a'.repeat(60) + '@' + 'a'.repeat(60) + '.'.repeat(60),
  // and under the length cap, so the pattern itself has to give up quickly
  'a.'.repeat(31) + '@' + 'a-'.repeat(90) + '!', 'x@' + 'a.'.repeat(120) + '1', 'a'.repeat(63) + '@' + 'aa.'.repeat(60) + 'c',
];
const t0 = process.hrtime.bigint();
for (const h of hostile) for (let i = 0; i < 200; i++) isValidEmail(h);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok(`${hostile.length * 200} long, hostile strings in ${ms.toFixed(0)} ms`, ms < 500);

(async () => {
  console.log('\nThe Email Report modal, adding a saved group');
  // A group saved before the check was strict still holds its typo. Adding it
  // leaves that address off, and says which — not dropped without a word.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.localStorage.setItem('fct_token', 'test-token');
  w.localStorage.setItem('fct_user', JSON.stringify({ role: 'admin' }));
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, isAdmin: true, groups: [{
    id: 7, name: 'Safety Report Group', project_id: null, report_type: null,
    emails: ['bhudock@forcecorporation.com', 'abotsford@forcecorporation..com', 'goakes@forcecorporation.com'],
  }] }) });
  w.eval(src);
  w.openReportEmailModal({ reportType: 'executive', getHTML: () => '<p>x</p>' });
  for (let i = 0; i < 50 && !w.document.querySelector('.rem-group-act[data-act="add"]'); i++) await new Promise(r => setTimeout(r, 10));
  const add = w.document.querySelector('.rem-group-act[data-act="add"]');
  ok('the group is offered', Boolean(add));
  if (add) add.click();
  const chips = [...w.document.querySelectorAll('#rem-chips > span')].map(c => c.firstChild.textContent.trim());
  ok('its good addresses become recipients, the typo does not',
    JSON.stringify(chips) === '["bhudock@forcecorporation.com","goakes@forcecorporation.com"]', JSON.stringify(chips));
  const status = (w.document.getElementById('rem-status') || {}).textContent || '';
  ok('…and the modal says which was left off, and how to fix it',
    status === 'Left off abotsford@forcecorporation..com — not a valid email address. Edit the group to fix it.', status);
  w.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
