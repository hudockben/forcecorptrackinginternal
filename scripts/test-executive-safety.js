'use strict';
/**
 * The executive report's Safety Sign-Off section: who has signed the week's
 * Safety Center document (with when), and who has not.
 *
 * Builds the section against a fake database, then renders it through
 * executive.html's own renderer in jsdom.
 *
 * Run:  node scripts/test-executive-safety.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 300));
};

const { buildSafetySignoff } = require('../api/executive/report.js');
const { mondayOf } = require('../api/lib/safety');

function localIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const THIS_WEEK = mondayOf(localIso(new Date()));

function makeSql({ weekDocs, latestDocs, sigs, roster }) {
  const seen = [];
  const sql = (strings) => {
    const text = strings.join('?');
    seen.push(text);
    if (/FROM\s+safety_documents/.test(text) && /week_of = /.test(text)) return Promise.resolve(weekDocs);
    if (/FROM\s+safety_documents/.test(text)) return Promise.resolve(latestDocs);
    if (/FROM\s+safety_signatures/.test(text)) return Promise.resolve(sigs);
    if (/FROM\s+users/.test(text)) return Promise.resolve(roster);
    throw new Error('unexpected query: ' + text);
  };
  sql.seen = seen;
  return sql;
}

const ROSTER = [
  { id: 1, username: 'amy',   division_roles: { safety: 'level1' } },
  { id: 2, username: 'bob',   division_roles: { safety: 'level1' } },
  { id: 3, username: 'carla', division_roles: { safety: 'level3' } },
];

(async () => {
  console.log('\n[this week\'s document, partly signed]');
  const sql = makeSql({
    weekDocs: [{ id: 'd1', title: 'Trench Safety Tailgate', week_of: THIS_WEEK, uploaded_at: new Date() }],
    latestDocs: [],
    sigs: [
      { document_id: 'd1', user_id: 1, username: 'amy', full_name: 'Amy Rivera', signed_at: new Date('2026-09-21T12:05:00Z') },
      { document_id: 'd1', user_id: 9, username: 'admin', full_name: 'Pat Admin', signed_at: new Date('2026-09-21T13:00:00Z') },
    ],
    roster: ROSTER,
  });
  const s = await buildSafetySignoff(sql, 'TEST_CO');
  const doc = s.documents[0];
  assert('uses this week\'s document', s.isCurrentWeek && doc.title === 'Trench Safety Tailgate');
  assert('signed list carries the timestamp', doc.signed[0].signedAt === '2026-09-21T12:05:00.000Z', JSON.stringify(doc.signed[0]));
  assert('not-signed is the roster minus who signed', JSON.stringify(doc.notSigned.map(n => n.username)) === '["bob","carla"]');
  assert('an off-roster signer is kept and flagged', doc.signed[1].onRoster === false);
  assert('headline counts roster members only', s.metrics[0].value === '1 / 3', s.metrics[0].value);
  assert('status names the outstanding count', s.status === '2 Not Signed' && s.statusKind === 'amber');
  assert('the drawn signature image is never read', !sql.seen.some(q => /signature_image/.test(q)));

  console.log('\n[nothing posted this week — falls back to the latest]');
  const s2 = await buildSafetySignoff(makeSql({
    weekDocs: [],
    latestDocs: [{ id: 'd0', title: 'Heat Stress', week_of: '2026-09-14', uploaded_at: new Date() }],
    sigs: ROSTER.map(r => ({ document_id: 'd0', user_id: r.id, username: r.username, full_name: r.username, signed_at: new Date() })),
    roster: ROSTER,
  }), 'TEST_CO');
  assert('falls back to the latest live document', !s2.isCurrentWeek && s2.documents[0].title === 'Heat Stress');
  assert('everyone signed reads All Signed', s2.status === 'All Signed' && s2.statusKind === 'green');

  console.log('\n[no documents at all]');
  const s3 = await buildSafetySignoff(makeSql({ weekDocs: [], latestDocs: [], sigs: [], roster: ROSTER }), 'TEST_CO');
  assert('no document reads No Document Posted', s3.status === 'No Document Posted' && s3.documents.length === 0);

  console.log('\n[executive.html renders it]');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'executive.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>\s*(?:<script|<\/body>)/)[1];
  const dom = new JSDOM('<div id="reportBody"><div id="portfolioSections"></div></div>', { runScripts: 'outside-only', url: 'http://localhost/executive.html' });
  const w = dom.window;
  // Only the renderers are wanted: stub what the page's top level reaches for.
  w.localStorage.setItem('fct_token', 't');
  w.localStorage.setItem('fct_user', JSON.stringify({ isPlatformAdmin: true }));
  w.fetch = () => new Promise(() => {});
  w.document.body.insertAdjacentHTML('beforeend',
    '<div id="reportLoading"></div><div id="reportError"></div><div id="reportErrorMsg"></div><span id="reportDate"></span>');
  try { w.eval(script); } catch (e) { /* later top-level wiring may need more DOM; renderers are already defined */ }
  w.renderReport({ portfolios: [], safety: s });
  const sec = w.document.getElementById('portfolio-safety');
  assert('the section renders', !!sec);
  const rows = sec ? Array.from(sec.querySelectorAll('tbody tr')).map(tr => tr.textContent.replace(/\s+/g, ' ').trim()) : [];
  assert('signed rows come first with a timestamp', /Amy Rivera.*Signed.*\d{1,2}:\d{2}/.test(rows[0] || ''), rows[0]);
  assert('the off-roster signer is flagged', /not on the signing roster/.test(rows[1] || ''), rows[1]);
  assert('then the names still to sign', /bob Not signed —/.test(rows[2] || '') && /carla Not signed/.test(rows[3] || ''), rows.slice(2).join(' | '));

  console.log(failed ? `\n✗ ${failed} failed` : '\n✅ all assertions passed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
