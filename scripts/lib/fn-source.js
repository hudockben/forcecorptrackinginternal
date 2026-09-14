'use strict';
/**
 * Lift a top-level `function name(...) { ... }` out of a source file by brace
 * matching, so a test can run the page's OWN function rather than a restatement
 * of it. A second copy of a rule is a second place for it to drift, which is
 * the whole reason these tests read the source at all.
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

module.exports = { fnSource, requireFn };
