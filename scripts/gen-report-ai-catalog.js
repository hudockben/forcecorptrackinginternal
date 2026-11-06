#!/usr/bin/env node
'use strict';
/**
 * Writes api/lib/report-ai-catalog.json — what the AI report builder
 * (api/ai/report-builder.js) is told the Custom Reporting catalog is.
 *
 * Run: node scripts/gen-report-ai-catalog.js          (writes the file)
 *      node scripts/gen-report-ai-catalog.js --check  (exit 1 if it is stale)
 *
 * The catalog — section types, their columns with the internal / financial
 * flags, their options, the date presets and layouts — lives in
 * custom-reports-engine.js, the browser file that builds every report. The
 * endpoint runs on the server, where that file is never loaded, and it must
 * not drift from it: a column the model is told about that the engine does
 * not know is dropped on apply, and a column the engine has that the model
 * was never told about is one it cannot offer. So the engine is loaded here in
 * a node vm, exactly as the engine's own test loads it, and the JSON is
 * written from E.aiCatalog(division) for each job division. An engine that
 * predates aiCatalog is read straight from E.CATALOG instead, the same shape.
 *
 * The output is deterministic — no dates, no machine paths — so the file in
 * the repo can be compared byte for byte with a fresh run.
 * scripts/test-report-builder-ai.js does exactly that, so a catalog change
 * that was not regenerated fails the suite rather than the model.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT        = path.resolve(__dirname, '..');
const ENGINE_FILE = path.join(ROOT, 'custom-reports-engine.js');
const OUT_FILE    = path.join(ROOT, 'api', 'lib', 'report-ai-catalog.json');
const DIVISIONS   = ['turf', 'paving', 'kiewit'];

/** The engine, loaded in a bare vm with nothing but a window object. */
function loadEngine(file) {
  const src = fs.readFileSync(file || ENGINE_FILE, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'custom-reports-engine.js' });
  const E = sandbox.window.FCTReportEngine || sandbox.FCTReportEngine;
  if (!E || !E.CATALOG) throw new Error('custom-reports-engine.js did not define FCTReportEngine.CATALOG');
  return E;
}

// A copy that has left the vm's realm: plain objects and arrays only.
const plain = v => JSON.parse(JSON.stringify(v === undefined ? null : v));

/**
 * The same shape E.aiCatalog returns, built from E.CATALOG — for an engine
 * that does not have aiCatalog yet. Division-scoped columns of other
 * divisions are left out, as aiCatalog leaves them out.
 */
function deriveCatalog(E, division) {
  const order = Array.isArray(E.SECTION_ORDER) && E.SECTION_ORDER.length ? E.SECTION_ORDER : Object.keys(E.CATALOG);
  const sections = order.filter(t => E.CATALOG[t]).map(t => {
    const cat = E.CATALOG[t];
    const columns = (cat.columns || [])
      .filter(c => !Array.isArray(c.divisions) || c.divisions.includes(division))
      .map(c => {
        const o = { key: c.key, label: c.label, type: c.type, internal: !!c.internal, financial: !!c.financial, default: !!c.def };
        if (Array.isArray(c.divisions)) o.divisions = c.divisions.slice();
        return o;
      });
    const options = (cat.optionSpec || []).map(o => {
      const x = { key: o.key, label: o.label, kind: o.kind, default: plain((cat.options || {})[o.key]) };
      if (Array.isArray(o.choices)) x.choices = o.choices.map(ch => ch[0]);
      return x;
    });
    return { type: t, label: cat.label, blurb: cat.blurb || '', table: !!cat.table, columns, options };
  });
  const starters = (Array.isArray(E.STARTERS) ? E.STARTERS : [])
    .filter(s => !Array.isArray(s.divisions) || s.divisions.includes(division))
    .map(s => ({ id: s.id, name: s.name, blurb: s.blurb,
      sections: ((s.definition && s.definition.sections) || []).map(x => x.type) }));
  return {
    version: E.VERSION,
    division,
    sections,
    datePresets: (E.DATE_PRESETS || []).map(p => ({ key: p.key, label: p.label })),
    layouts: ['separate', 'combined'],
    orientations: ['portrait', 'landscape'],
    headerBranding: ['company', 'datawatch'],
    limits: { sections: 20, filterCodes: 200, filterCodeLength: 60 },
    starters,
  };
}

/** Throws on a catalog the endpoint could not build its schema from. */
function checkShape(cat, division) {
  const bad = msg => { throw new Error(`AI catalog for ${division}: ${msg}`); };
  if (!cat || typeof cat !== 'object') bad('not an object');
  if (!Array.isArray(cat.sections) || !cat.sections.length) bad('no sections');
  const types = new Set();
  cat.sections.forEach(s => {
    if (!s || typeof s.type !== 'string' || !s.type) bad('a section has no type');
    if (types.has(s.type)) bad(`section ${s.type} appears twice`);
    types.add(s.type);
    if (!Array.isArray(s.columns)) bad(`section ${s.type} has no column list`);
    if (!Array.isArray(s.options)) bad(`section ${s.type} has no option list`);
    s.columns.forEach(c => {
      if (!c || typeof c.key !== 'string' || typeof c.internal !== 'boolean' || typeof c.financial !== 'boolean') {
        bad(`section ${s.type} has a column without key / internal / financial`);
      }
      if (c.financial && !c.internal) bad(`${s.type}.${c.key} is financial but not internal`);
      if (Array.isArray(c.divisions) && !c.divisions.includes(division)) bad(`${s.type}.${c.key} belongs to another division`);
    });
  });
  if (!Array.isArray(cat.datePresets) || !cat.datePresets.some(p => p && p.key === 'last_week')) bad('date presets missing');
  if (!Array.isArray(cat.layouts) || !cat.layouts.length) bad('layouts missing');
  return cat;
}

/* JSON with every leaf object on one line — a column, an option, a preset —
   so a catalog change is a one-line diff instead of eight. */
const isLeaf = v => v === null || typeof v !== 'object';
const isFlat = v => (Array.isArray(v) ? v.every(isLeaf)
  : Object.keys(v).every(k => isLeaf(v[k]) || (Array.isArray(v[k]) && v[k].every(isLeaf))));
function fmt(v, ind) {
  if (isLeaf(v)) return JSON.stringify(v);
  const inline = x => (Array.isArray(x)
    ? '[' + x.map(y => (isLeaf(y) ? JSON.stringify(y) : inline(y))).join(', ') + ']'
    : '{ ' + Object.keys(x).map(k => JSON.stringify(k) + ': ' + (isLeaf(x[k]) ? JSON.stringify(x[k]) : inline(x[k]))).join(', ') + ' }');
  if (isFlat(v)) return Array.isArray(v) && !v.length ? '[]' : (!Array.isArray(v) && !Object.keys(v).length ? '{}' : inline(v));
  const pad = ind + '  ';
  if (Array.isArray(v)) return '[\n' + v.map(x => pad + fmt(x, pad)).join(',\n') + '\n' + ind + ']';
  return '{\n' + Object.keys(v).map(k => pad + JSON.stringify(k) + ': ' + fmt(v[k], pad)).join(',\n') + '\n' + ind + '}';
}

/** The file's exact contents, as a string. */
function build(engineFile) {
  const E = loadEngine(engineFile);
  const source = typeof E.aiCatalog === 'function' ? 'aiCatalog' : 'CATALOG';
  const divisions = {};
  DIVISIONS.forEach(d => {
    const cat = source === 'aiCatalog' ? plain(E.aiCatalog(d)) : plain(deriveCatalog(E, d));
    divisions[d] = checkShape(cat, d);
  });
  const out = {
    _generated: 'By scripts/gen-report-ai-catalog.js from custom-reports-engine.js. Do not edit by hand: run node scripts/gen-report-ai-catalog.js after changing the engine catalog.',
    engineVersion: E.VERSION,
    source,
    divisions,
  };
  return fmt(out, '') + '\n';
}

module.exports = { build, loadEngine, deriveCatalog, checkShape, fmt, OUT_FILE, ENGINE_FILE, DIVISIONS };

if (require.main === module) {
  const json = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (cur !== json) {
      console.error('api/lib/report-ai-catalog.json is stale — run node scripts/gen-report-ai-catalog.js');
      process.exit(1);
    }
    console.log('api/lib/report-ai-catalog.json is up to date.');
  } else {
    fs.writeFileSync(OUT_FILE, json);
    console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${json.length} bytes).`);
  }
}
