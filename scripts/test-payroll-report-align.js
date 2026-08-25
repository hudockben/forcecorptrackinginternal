#!/usr/bin/env node
'use strict';
/**
 * Column-alignment test for the Payroll Hours Report (payroll.html).
 *
 * Run: node scripts/test-payroll-report-align.js
 *
 * The report's Totals row lives in <tfoot>, and the CSS that right-aligns the
 * figures and pads the cells used to be scoped to `tbody`. The totals row
 * therefore rendered left-adjusted with hairline padding — 417.75 sat a
 * column-width away from the HOURS header it belonged to, and payroll could
 * not tell which figure went with which heading.
 *
 * This pulls the real <thead>, body <tr> and totals <tr> templates straight
 * out of the page source, drops them into jsdom with the page's own <style>,
 * and asserts — per column — that the totals cell agrees with the header and
 * the body cells above it on text-align and horizontal padding. Same for the
 * per-employee detail table and the analytics Hours-by-Employee table, both of
 * which put their total in a <tfoot> too.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
}

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'payroll.html'), 'utf8');

// ── Pull the markup templates out of the page source ──────────────────
// Everything the renderers interpolate is dropped; only the shape of the
// table survives, which is all the cascade needs.
function stripInterp(s) {
  let prev;
  do { prev = s; s = s.replace(/\$\{[^{}]*\}/g, ''); } while (s !== prev);
  return s.replace(/`/g, '');
}

function between(start, end) {
  const a = HTML.indexOf(start);
  const b = HTML.indexOf(end, a + 1);
  if (a < 0 || b < 0) {
    console.error(`could not slice payroll.html between "${start}" and "${end}"`);
    process.exit(1);
  }
  return HTML.slice(a, b);
}

function grab(src, re, what) {
  const m = src.match(re);
  if (!m) {
    console.error(`could not find ${what} in payroll.html`);
    process.exit(1);
  }
  return stripInterp(m[0]);
}

const reportSrc = between('function renderReport()', 'function reportDetailHtml(');
const detailSrc = between('function reportDetailHtml(', 'function toggleReportRow(');
const anaSrc    = between('const empBody = empRows.map', 'Hours by Supervisor');

const TABLES = [
  {
    label: 'Payroll Hours Report',
    wrap:  html => `<div class="report"><div class="report-scroll"><table>${html}</table></div></div>`,
    head:  grab(reportSrc, /<thead>[\s\S]*?<\/thead>/,          'the report <thead>'),
    body:  grab(reportSrc, /<tr class="emp-row[\s\S]*?<\/tr>/,  'the report employee row'),
    foot:  grab(reportSrc, /<tr class="total">[\s\S]*?<\/tr>/,  'the report totals row'),
  },
  {
    label: 'per-employee detail table',
    wrap:  html => `<div class="report"><table class="report-detail-table">${html}</table></div>`,
    head:  grab(detailSrc, /<thead>[\s\S]*?<\/thead>/,               'the detail <thead>'),
    body:  grab(detailSrc, /<tr>\s*<td class="date">[\s\S]*?<\/tr>/, 'the detail entry row'),
    foot:  grab(detailSrc, /<tr class="detail-total">[\s\S]*?<\/tr>/, 'the detail total row'),
  },
  {
    label: 'analytics — Hours by Employee',
    wrap:  html => `<div class="ana-block"><table>${html}</table></div>`,
    head:  grab(anaSrc, /<thead>[\s\S]*?<\/thead>/,               'the analytics <thead>'),
    body:  grab(anaSrc, /<tr>\s*<td class="name">[\s\S]*?<\/tr>/, 'the analytics employee row'),
    foot:  grab(anaSrc, /<tr class="total">[\s\S]*?<\/tr>/,       'the analytics totals row'),
  },
];

const css = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const dom = new JSDOM(
  `<!doctype html><html><head><style>${css}</style></head><body>` +
  TABLES.map((t, i) =>
    `<div id="t${i}">${t.wrap(`${t.head}<tbody>${t.body}</tbody><tfoot>${t.foot}</tfoot>`)}</div>`
  ).join('') +
  '</body></html>'
);
const { document, getComputedStyle } = dom.window;
const align = elm => getComputedStyle(elm).textAlign || 'left';

TABLES.forEach((t, i) => {
  console.log(`\n[${t.label}]`);
  const table = document.querySelector(`#t${i} table`);
  const heads = [...table.querySelectorAll('thead th')];
  // The report's employee row is followed by its hidden detail row; take the
  // cells of the first body row only.
  const bodys = [...table.querySelector('tbody tr').children];
  const foots = [...table.querySelector('tfoot tr').children];

  const span = td => Number(td.getAttribute('colspan') || 1);
  const footCols = foots.reduce((n, td) => n + span(td), 0);
  assert('totals row spans every column',
         footCols === heads.length && bodys.length === heads.length,
         `${heads.length} headers / ${bodys.length} body cells / ${footCols} totals columns`);

  // Walk the totals row column by column, skipping any cell that spans
  // several columns (the detail table's "Total — N entries" label).
  let col = 0;
  for (const foot of foots) {
    const width = span(foot);
    if (width === 1 && heads[col] && bodys[col]) {
      const head = heads[col];
      const body = bodys[col];
      const name = head.textContent.replace(/\s+/g, ' ').trim() || `column ${col + 1}`;
      assert(`${name}: totals sit under the header (${align(foot)})`,
             align(foot) === align(head),
             `header=${align(head)} totals=${align(foot)}`);
      assert(`${name}: totals line up with the figures above`,
             align(foot) === align(body),
             `body=${align(body)} totals=${align(foot)}`);
      const b = getComputedStyle(body), f = getComputedStyle(foot);
      assert(`${name}: totals keep the column's side padding`,
             f.paddingLeft === b.paddingLeft && f.paddingRight === b.paddingRight,
             `body=${b.paddingLeft}/${b.paddingRight} totals=${f.paddingLeft}/${f.paddingRight}`);
      assert(`${name}: totals cell carries the same num/name class as the body`,
             ['num', 'name'].every(c => foot.classList.contains(c) === body.classList.contains(c)),
             `body="${body.className}" totals="${foot.className}"`);
    }
    col += width;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
