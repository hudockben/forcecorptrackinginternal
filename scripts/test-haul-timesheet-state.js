#!/usr/bin/env node
'use strict';
/**
 * The hauling answer survives the roster call landing late.
 *
 * Run: node scripts/test-haul-timesheet-state.js
 *
 * timesheet.html learns whether the signed-in user is a truck driver from
 * /api/timesheet-supervisors, and init() fires that request CONCURRENTLY with
 * the one that draws the entry cards:
 *
 *     await Promise.all([loadSupervisors(), loadEntries()]);
 *
 * So there is a real window where the cards are on screen and isDriver is still
 * null. A driver who taps a saved draft inside that window had
 * fillBlockFromEntry store his 'off_site' answer and applyHaulVisibility wipe it
 * on the very next line — because that function used to clear haulVals whenever
 * isDriver was not yet TRUE. The flag then arrived true, the control rendered
 * "No", and saving posted haul_type '' — silently moving his hours back into
 * prevailing and re-billing his wage to the job on the next approval.
 *
 * The fix is that applyHaulVisibility is purely presentational. Nothing needs
 * the clear: buildPayloads decides what to POST from isDriver directly.
 *
 * Evaluates the real functions out of timesheet.html — no browser needed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '../timesheet.html'), 'utf8');

function fnSource(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in timesheet.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

// A sandbox holding just what these two functions touch. setHaul writes to the
// DOM, so every element is a stub that records what it was told.
function sandbox(isDriver, haulVals, blocks = [0]) {
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, style: {},
    querySelectorAll: () => [],
  });
  const sb = {
    console, isDriver, haulVals,
    blockOrder: () => blocks,
    bel: (i, key) => el(i === 0 ? key : `s${i}-${key}`),
    setHaul(val, i) { sb.__setHaulCalls.push([val, i]); sb.haulVals[i] = val || ''; },
    __setHaulCalls: [],
    __els: els,
  };
  vm.createContext(sb);
  vm.runInContext(fnSource('applyHaulVisibility'), sb);
  return sb;
}

console.log('\n[the roster call has not landed yet — isDriver is null]');

{
  // fillBlockFromEntry stores the saved answer, then calls applyHaulVisibility.
  const sb = sandbox(null, { 0: 'off_site' });
  sb.applyHaulVisibility(0);
  assert('a saved off-site haul survives being rendered while the flag is unknown',
    sb.haulVals[0] === 'off_site', `haulVals[0] = ${JSON.stringify(sb.haulVals[0])}`);
  assert('  and the question stays hidden, because we do not know yet',
    sb.__els['row-haul'].style.display === 'none');
}
{
  const sb = sandbox(null, { 0: 'on_site' });
  sb.applyHaulVisibility();
  assert('the same holds for the whole-form pass', sb.haulVals[0] === 'on_site');
}

console.log('\n[the flag arrives — the control shows what was saved]');

{
  // The real sequence: render at null, then loadSupervisors resolves true and
  // applyHaulVisibility() runs again over every block.
  const sb = sandbox(null, { 0: 'off_site' });
  sb.applyHaulVisibility(0);
  sb.isDriver = true;
  sb.applyHaulVisibility();
  assert('the driver sees the answer he actually saved, not "No"',
    sb.haulVals[0] === 'off_site',
    `setHaul calls: ${JSON.stringify(sb.__setHaulCalls)}`);
  assert('  and the question is now shown',
    sb.__els['row-haul'].style.display === 'flex');
}

console.log('\n[a non-driver]');

{
  const sb = sandbox(false, { 0: '' });
  sb.applyHaulVisibility();
  assert('never sees the question', sb.__els['row-haul'].style.display === 'none');
  assert('  and setHaul is never called for them', sb.__setHaulCalls.length === 0);
}

console.log('\n[what actually gets posted is decided by isDriver, not by haulVals]');

// This is why applyHaulVisibility does not need to clear anything: buildPayloads
// reads isDriver directly. Pinned as source, because the three branches are the
// contract the fix above relies on.
const build = src.slice(src.indexOf('function buildPayloads('),
                        src.indexOf('function buildPayloads(') + 12000);
assert('unknown roster (null) posts NO haul_type key, so the server keeps what it has',
  /haulKey: isDriver === null\s*\n\s*\? \{\}/.test(build));
assert('a non-driver posts an explicit empty answer, which clears any stale value',
  /: \{ haul_type: isDriver \? \(haulVals\[i\] \|\| ''\) : '' \}/.test(build));
assert('the payload spreads that key rather than always sending the field',
  /\}, b\.haulKey, splitTagFor\(/.test(build));

// And the guard itself: a render function that writes to haulVals is the bug.
const vis = fnSource('applyHaulVisibility');
assert('applyHaulVisibility never assigns to haulVals — it only renders',
  !/haulVals\s*\[[^\]]*\]\s*=/.test(vis), vis);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
