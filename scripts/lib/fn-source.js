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
 * Returns the function's full source, or null when it is not found.
 */
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
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
