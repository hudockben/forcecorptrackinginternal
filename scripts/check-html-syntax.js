#!/usr/bin/env node
'use strict';
/**
 * Parses a division page and syntax-checks every inline <script> in it.
 *
 * Run: node scripts/check-html-syntax.js tracker.html [more.html ...]
 *      node scripts/check-html-syntax.js            (checks every *.html)
 *
 * These pages are 30k lines of markup and JavaScript in one file, edited in
 * place. A stray brace or an unclosed tag does not surface until the page is
 * loaded in a browser and the whole app is blank, so this runs the parse a
 * browser would: jsdom for the markup, node's own parser for each script.
 *
 * Skips <script src> (nothing inline to check) and JSON/template blocks.
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.html'));

let failed = 0;

for (const file of files) {
  const full = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
  const html = fs.readFileSync(full, 'utf8');

  let dom;
  try {
    // runScripts is left off deliberately: this checks that the scripts PARSE,
    // not that they run — running them would need a whole browser environment.
    dom = new JSDOM(html);
  } catch (err) {
    console.error(`✗ ${file} — markup did not parse: ${err.message}`);
    failed++;
    continue;
  }

  // jsdom's parser is HTML5-lenient: it silently repairs an unclosed <div> by
  // nesting everything after it, and reports no error at all. On a 30k-line
  // hand-edited page that is exactly the mistake worth catching, so check tag
  // balance against the source before trusting the parse.
  const BALANCED = ['div', 'table', 'thead', 'tbody', 'tr', 'select', 'button', 'span'];
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  let unbalanced = 0;
  for (const tag of BALANCED) {
    const open  = (stripped.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
    const close = (stripped.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    if (open !== close) {
      console.error(`✗ ${file} — <${tag}> is unbalanced: ${open} opened, ${close} closed`);
      unbalanced++;
    }
  }
  if (unbalanced) { failed++; continue; }

  const scripts = [...dom.window.document.querySelectorAll('script')]
    .filter(s => !s.src && s.textContent.trim())
    .filter(s => {
      const type = (s.type || '').toLowerCase();
      return !type || type === 'text/javascript' || type === 'module';
    });

  let bad = 0;
  scripts.forEach((s, i) => {
    try {
      new vm.Script(s.textContent, { filename: `${file}#script[${i}]` });
    } catch (err) {
      console.error(`✗ ${file} — script[${i}] ${err.message}`);
      bad++;
    }
  });

  if (bad) { failed++; continue; }
  console.log(`✓ ${file} — markup parses, ${scripts.length} inline script${scripts.length === 1 ? '' : 's'} OK`);
}

process.exit(failed ? 1 : 0);
