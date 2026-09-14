'use strict';
const vm = require('vm');
/**
 * Lifting page source into a test, in one place.
 *
 * These suites run the PAGE'S own functions rather than a restatement of them —
 * a second copy of a rule is a second place for it to drift, which is the whole
 * reason they read the source at all. Three ways in:
 *
 *   fnSource / requireFn   one function, by name, brace-matched
 *   sliceSource            a region, between two markers
 *   evalSlice              run a lifted region in a vm context, and say
 *                          something useful when a global is missing
 *
 * The last two exist because every one of these suites has now been bitten by
 * the same thing: the page grows, the lifted region stops covering what the
 * test needs, and the failure surfaces a long way from the cause. Both guards
 * below turn that into a message that names it.
 */

/**
 * Lift a top-level `function name(...) { ... }` out of a source file by brace
 * matching.
 *
 * Was written out inline in five test files — three of them added at once —
 * with the same shortcut in each: braces are counted without regard for the
 * ones inside strings, template literals, regex literals or comments. A
 * function containing `'{'` therefore ends early and comes back unparseable.
 * None of the functions these tests lift does that today; keeping one copy is
 * what makes it fixable in one place if one ever does.
 *
 * The parameter list is stepped over before the body is counted, because a
 * DESTRUCTURED parameter opens a brace that is not the body:
 * `function xlsxSheetXml({ colWidths, rows })` used to come back as its own
 * signature and nothing else, and the test lifting it died on a syntax error
 * pointing at the next function down.
 *
 * Returns the function's full source, or null when it is not found.
 */
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { i++; break; }
  }
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
}

/** The same, but a missing function is a hard error — most callers want that. */
function requireFn(src, name, where) {
  const out = fnSource(src, name);
  if (!out) throw new Error(`${name} not found${where ? ` in ${where}` : ''}`);
  return out;
}

/**
 * Lift the region of a page between two markers.
 *
 * `label` names the region for the error message. `must` — a string or an array
 * of them — is what the region has to CONTAIN, and it is the guard that matters:
 * a missing marker has always thrown, but a marker matching TOO EARLY never
 * did, and that is the one that keeps happening. A banner comment written
 * between the start marker and the function the slice exists to reach cut the
 * region short in test-truck-list-deletions, and the run died two hundred lines
 * later on "p.updateField is not a function" with nothing in it about markers.
 *
 * So name what you came for. Pin the LAST thing the region has to provide —
 * everything before it is covered by reaching that — and the slice reports its
 * own truncation, at the slice, in the terms you wrote it in.
 *
 * Was written out inline in eleven test files with the same signature and the
 * same gap in each.
 */
function sliceSource(src, from, to, label, must) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) {
    throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  }
  const out = src.slice(a, b);
  for (const need of [].concat(must || [])) {
    if (!out.includes(need)) {
      throw new Error(`${label}: the slice stops short of ${JSON.stringify(need)} — `
        + `the end marker ${JSON.stringify(to)} now matches earlier than it used to`);
    }
  }
  return out;
}

/**
 * Run a lifted region inside a vm context, and turn the one error these
 * harnesses actually produce into an instruction.
 *
 * A region that reads a global the page declares OUTSIDE it throws
 * "x is not defined" from somewhere in the middle of a page's source — true,
 * and no help at all. It means one of two things, and the message says both:
 * lift more of the page, or stub the collaborator. What it never means is that
 * the page is broken.
 *
 * Only reaches evaluation-time reads. A global a lifted FUNCTION reaches for
 * when it is called later throws at call time instead, where the page's own
 * try/catch may well swallow it — see missingGlobals for that half.
 */
function evalSlice(code, ctx, what, opts) {
  try {
    vm.runInContext(code, ctx, opts);
  } catch (err) {
    const missing = /^(\w+) is not defined$/.exec(err.message);
    if (missing) {
      throw new Error(
        `${what} reads "${missing[1]}", which the page declares outside the slice `
        + `lifted here. The page is fine; this harness is missing a global. Either `
        + `widen the slice or add \`${missing[1]}\`` + ` to the sandbox — a no-op stub is `
        + `enough unless an assertion is actually about it.`);
    }
    throw err;
  }
}

/**
 * The other half: the lines a sandbox captured that are really a missing
 * global, not a failure the test provoked.
 *
 * Page code that loads over a network runs inside a try/catch whose job is to
 * turn a failure into something the user can act on — a retry, an empty state,
 * a cached fallback. That catch cannot tell a 403 from a ReferenceError, so a
 * harness missing a collaborator gets reported as a failed load and the suite
 * goes green on its failure cases while its success cases quietly go red. That
 * is exactly how test-timesheet-job-picker-auth lost three assertions.
 *
 * Hand it whatever the sandbox's console captured; assert the result is empty.
 */
function missingGlobals(lines) {
  return [].concat(lines || [])
    .map(l => (Array.isArray(l) ? l.join(' ') : String(l)))
    .filter(l => /\bis not defined\b/.test(l));
}

module.exports = { fnSource, requireFn, sliceSource, evalSlice, missingGlobals };
