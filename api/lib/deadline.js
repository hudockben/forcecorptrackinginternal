'use strict';
/**
 * A deadline of our own, shorter than the platform's.
 *
 * Every endpoint here that calls a model with web search has the same
 * problem: Vercel kills the function at maxDuration and the caller receives a
 * bodiless 504. The code after the call never runs, so there is nowhere to
 * say what happened, nothing is written, and the tab shows a gateway error
 * number instead of a sentence. Losing the race on our own terms leaves the
 * handler alive to answer honestly and keep whatever was already stored.
 *
 * The rejection carries `deadline: true` so a caller can tell "this took too
 * long" apart from "this failed" — different things to tell a user.
 *
 * Three files had grown their own copy of this. One copy, one behaviour.
 */
function withDeadline(promise, ms, message) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(
        new Error(message || 'it did not finish in the time the server allows'),
        { deadline: true })),
      ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

module.exports = { withDeadline };
