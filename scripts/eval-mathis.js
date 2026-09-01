#!/usr/bin/env node
'use strict';
/**
 * Is Mathis giving good answers?
 *
 * Run: node scripts/eval-mathis.js --yes
 *      node scripts/eval-mathis.js --list
 *      node scripts/eval-mathis.js --yes --only trucking
 *
 * scripts/test-mathis.js never calls the model. It stubs it out and asserts on
 * what went IN — the digest was scoped correctly, the prompt carried the right
 * caveat, the table rendered from data. That proves the plumbing, and plumbing
 * was the right thing to prove first.
 *
 * This is the other half, and it is the half nothing else covers: call the real
 * model against real data and judge what comes OUT. Not "was it given the right
 * facts" but "did it say something true and useful".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY MOST OF THESE ASSERTIONS ARE NEGATIVE
 *
 * The failures that matter here are not wrong arithmetic — the arithmetic is
 * shared with the pages and pinned by port-equivalence tests. They are Mathis
 * saying something it should have refused: quoting trucking revenue when asked
 * for trucking profit, reporting a missing contract as a loss, adding a
 * per-ton contribution to a job profit. Every one of those is already written
 * down as a `limits` entry in the digests, which makes each limit a test case.
 * So the cases below are largely drawn from those, and most check for the
 * ABSENCE of a claim rather than the presence of a number.
 *
 * A test that asserts a specific figure would also have to be rewritten every
 * time somebody adds a job.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT NEEDS
 *   DATABASE_URL         a real database — the fixtures in test-mathis.js
 *                        would only measure whether Mathis can read two fake
 *                        paving jobs, which is worth nothing
 *   ANTHROPIC_API_KEY    the same key the app uses
 *   MATHIS_EVAL_USER     a user id in that database to run as
 *   MATHIS_EVAL_COMPANY  their company code
 *   JWT_SECRET           to mint a token for them
 *
 * Every run costs real money — roughly $0.07 a case — which is why --yes is
 * required and why --list exists to read the set without spending anything.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../api/.env') });
const jwt = require('jsonwebtoken');

const argv    = process.argv.slice(2);
const CONFIRM = argv.includes('--yes');
const LIST    = argv.includes('--list');
const ONLY    = (argv.find(a => a.startsWith('--only')) || '').split('=')[1]
             || (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null);
const VERBOSE = argv.includes('--verbose');

// ── The set ────────────────────────────────────────────────────────────────
// `expect` entries:
//   say    — a regex the answer MUST match
//   avoid  — a regex the answer must NOT match
//   note   — why this case exists, printed on failure
const MONEY = /\$\s?[\d,]+(\.\d+)?|[\d,]+\s?dollars/i;

const CASES = [
  // ── The question this was built for ────────────────────────────────────
  { id: 'paving-profit', division: 'paving',
    ask: 'how much profit was made on the last 5 projects',
    expect: [
      { say: /projected|projection/i, note: 'profit here is contract minus PROJECTED final cost, and saying so is the whole point' },
      { avoid: /\bcost to date\b|\bspent so far\b.{0,40}\bprofit\b/i, note: 'cost-to-date flatters a half-spent job' },
    ] },
  { id: 'paving-ordering', division: 'paving',
    ask: 'what were the last 5 paving jobs',
    expect: [{ say: /recent|order|pinned|latest/i, note: 'projects carry no created-at, so which ordering it used has to be stated' }] },
  { id: 'paving-no-contract', division: 'paving',
    ask: 'is any job showing an unknown profit, and why',
    expect: [
      { avoid: /\bbreak(ing)? even\b|\bzero profit\b|\bno profit\b/i, note: 'a missing contract is unknown, not break-even' },
    ] },

  // ── The refusals. These are the ones that matter. ──────────────────────
  { id: 'trucking-profit', division: 'trucking',
    ask: 'how much profit did we make on trucking this year',
    expect: [
      { say: /(no|not).{0,30}(cost|profit)|do(es)? ?n.t (track|capture|record)/i,
        note: 'trucking captures no cost anywhere — profit is not a number that exists' },
      { avoid: MONEY, note: 'ANY dollar figure here reads as the profit that was asked for' },
    ] },
  { id: 'trucking-margin', division: 'trucking',
    ask: "what's our margin on trucking",
    expect: [{ avoid: /\b\d+(\.\d+)?\s?%/, note: 'no cost means no margin either — a percentage here is invented' }] },
  { id: 'payroll-dollars', division: 'payroll',
    ask: 'what did we spend on labour this pay period',
    expect: [
      { say: /(no|not).{0,30}(rate|pay|dollar|wage)/i, note: 'payroll carries hours and no rate of any kind' },
      { avoid: MONEY, note: 'there is no rate in this data to multiply by' },
    ] },
  { id: 'paving-trend', division: 'paving',
    ask: 'is our paving margin improving compared with last quarter',
    expect: [
      { say: /(no|not).{0,40}(history|as.of|over time|past period)/i,
        note: 'contract values have no as-of history, so a past period cannot be reconstructed' },
    ] },
  { id: 'quarry-tax', division: 'quarry',
    ask: 'how much sales tax did the quarry collect this year',
    expect: [{ say: /(not|no).{0,40}(available|here|server)/i, note: 'sales tax is derived in the browser and is in no server-side figure' }] },

  // ── Saying what a figure MEANS, not just what it is ────────────────────
  { id: 'quarry-margin', division: 'quarry',
    ask: "what's our margin at the quarry",
    expect: [
      { say: /per ton|\/ ?ton|contribution/i, note: 'quarry margin is a per-ton contribution, not job profit' },
      { avoid: /profit on (the|a) (job|project)/i, note: 'it must never be described as profit on a project' },
    ] },
  { id: 'dust-margin', division: 'dust',
    ask: "what's our margin on a gallon of UB",
    expect: [{ say: /invoice|UB|custom|basis/i, note: 'the three charge bases give different margins and the division picks one' }] },
  { id: 'dust-books', division: 'dust',
    ask: 'what did dust bill this year',
    expect: [{ say: /tracking|other billing|EES/i, note: 'revenue spans three books and a single figure hides that' }] },
  { id: 'scheduler-conflict', division: 'scheduler',
    ask: 'is anybody double-booked',
    expect: [{ say: /day|same day/i, note: 'a conflict is per day, not per hour — a morning/afternoon split is not a problem' }] },
  { id: 'scheduler-nodata', division: 'scheduler',
    ask: 'how many sub-codes are on track',
    expect: [{ avoid: /all (of them|sub.?codes) are on track/i, note: 'unmeasured is not on track' }] },

  // ── Scope ──────────────────────────────────────────────────────────────
  { id: 'exec-rollup', division: 'executive',
    ask: 'give me the company-wide numbers',
    expect: [
      { say: /division|access|cover/i, note: 'the rollup covers only what the caller can reach and must say so' },
      { avoid: /company.?wide total|across the (whole )?company/i, note: 'it is not a company-wide total' },
    ] },
  { id: 'exec-no-adding', division: 'executive',
    ask: 'add up the totals across the divisions',
    expect: [{ say: /(cannot|can.t|different|not comparable)/i, note: 'profit, contribution per ton and hours cannot be summed' }] },
  { id: 'cross-division', division: 'paving',
    ask: 'what did the quarry sell last month',
    expect: [{ avoid: /\btons\b.{0,40}\$/i, note: 'a paving-only caller must not receive quarry figures' }] },

  // ── Answering a different question than the one asked ──────────────────
  // A real report: asked about rubber inventory on turf, it came back with
  // projected profit. A wrong-SUBJECT answer is worse than a wrong figure,
  // because it looks like an answer and there is no way to tell.
  { id: 'turf-inventory', division: 'turf',
    ask: 'how much rubber do we have in stock',
    expect: [
      { say: /bag|stock|rubber|crumb|buffing/i, note: 'turf carries rubber inventory and this is what was asked for' },
      { avoid: /projected profit|contract value/i, note: 'the profit figures are not an answer to an inventory question' },
    ] },
  { id: 'paving-no-inventory', division: 'paving',
    ask: 'how much rubber do we have in stock',
    expect: [
      { say: /(no|not|do ?n.t).{0,40}(have|track|see|cover)/i, note: 'paving carries no inventory and must say so' },
      { avoid: /\bprofit\b.{0,40}\$/i, note: 'describing what it does have instead is the bug this case exists for' },
    ] },

  // ── Purchase orders and cost codes ─────────────────────────────────────
  // The failure mode here is arithmetic, not subject. A PO's value is what
  // was ORDERED; the job rows in the same digest already count delivered
  // material in their actual cost. Adding the two counts the same concrete
  // twice, and the answer looks perfectly reasonable when it does.
  { id: 'po-total', division: 'paving',
    ask: 'how much have we got out on purchase orders',
    expect: [
      { say: /order/i, note: 'the figure is what was ordered, and calling it that is the answer' },
      { avoid: /\bspent\b|\bpaid\b|\binvoiced\b/i, note: 'a PO is none of those three' },
    ] },
  { id: 'po-not-cost', division: 'paving',
    ask: 'what is our total cost on paving including purchase orders',
    expect: [
      { say: /(not|do ?n.t|cannot|can.t|should ?n.t).{0,60}(add|combin|includ|sum)|double.?count|already/i,
        note: 'the two must not be added — the jobs table already counts delivered material' },
    ] },
  { id: 'po-supplier', division: 'paving',
    ask: 'which supplier have we ordered the most from',
    expect: [{ say: /\$\s?[\d,]/, note: 'the per-supplier totals are in the digest, so this is answerable' }] },
  { id: 'cost-codes', division: 'paving',
    ask: 'how much have we spent against cost code 2100',
    expect: [
      { say: /(catalog|not|do ?n.t|unit cost|bid).{0,80}(spend|spent)|per.job|actual cost/i,
        note: 'the catalogue is quantities and unit costs, not spend against a code' },
    ] },

  // ── Equipment and documents ────────────────────────────────────────────
  // Equipment money is the purchase-order trap run backwards: this cost is
  // INSIDE the job's actual cost, so adding it counts the same roller twice.
  { id: 'equip-hours', division: 'paving',
    ask: 'which piece of equipment ran the most hours',
    expect: [{ say: /hour/i, note: 'the hours are in the digest, so this is answerable' }] },
  { id: 'equip-not-extra', division: 'paving',
    ask: 'what is our total paving cost once I add in the equipment',
    expect: [
      { say: /(already|include[ds]?).{0,60}(actual|job|cost)|do ?n.t.{0,40}add|double.?count/i,
        note: 'equipment cost is a breakdown of actual cost, never an addition to it' },
    ] },
  { id: 'equip-assigned-vs-run', division: 'paving',
    ask: 'is every machine assigned to a job actually being used on it',
    expect: [
      { say: /assign|plan|intend/i, note: 'assignment and hours are different facts and the answer turns on that' },
    ] },
  { id: 'docs-count', division: 'paving',
    ask: 'which jobs have no paperwork on file',
    expect: [{ say: /\bjob|none|no (document|file|paperwork)/i, note: 'the digest lists exactly this' }] },
  // The one that will be asked and cannot be answered.
  { id: 'docs-contents', division: 'paving',
    ask: 'what does the Atwood contract say about liquidated damages',
    expect: [
      { say: /(no|not|do ?n.t|cannot|can.t).{0,60}(read|content|inside|open|text|see what)/i,
        note: 'the vault is counted, never read — a filename is not a contract' },
    ] },

  // ── Employees ──────────────────────────────────────────────────────────
  // The eval runs as whoever holds the API key's account. These cases assert
  // the SHAPE of the answer either way: named crew is fine, and labor money is
  // the same breakdown-not-addition trap equipment sets.
  { id: 'crew-on-a-job', division: 'paving',
    ask: 'who is assigned to our most recent job',
    expect: [{ avoid: /\bper hour\b.{0,20}\$|\$[\d,.]+\s*(an|per|\/)\s*h/i,
               note: 'the question is who, and a rate volunteered here is a rate nobody asked for' }] },
  { id: 'labor-not-extra', division: 'paving',
    ask: 'what is our paving cost once I add the labor on top',
    expect: [
      { say: /(already|include[ds]?).{0,60}(actual|job|cost)|do ?n.t.{0,40}add|double.?count/i,
        note: 'labor cost is a breakdown of actual cost, never an addition to it' },
    ] },
  { id: 'assigned-vs-worked', division: 'paving',
    ask: 'has everyone assigned to the job actually logged hours on it',
    expect: [{ say: /assign|plan|logged|actually/i,
               note: 'assignment and hours are different facts and the answer turns on that' }] },
  // A rate is the figure most likely to be guessed at when it is withheld.
  { id: 'no-invented-rate', division: 'paving',
    ask: 'estimate what our average hourly labor rate works out to',
    expect: [
      { avoid: /\bestimat\w+\s+(is|at|around|about)\b.{0,20}\$|roughly \$|approximately \$/i,
        note: 'either the rates are in the digest and it is arithmetic, or they are withheld and it is a refusal — never a guess' },
    ] },

  // ── Personal ───────────────────────────────────────────────────────────
  { id: 'my-hours', division: 'timesheet',
    ask: 'how many hours did I log this week',
    expect: [{ avoid: MONEY, note: 'timesheet data carries no rate' }] },

  // ── Being talked to like a person ──────────────────────────────────────
  // "Hello" used to cost a tool call and come back as "I don't have that".
  // Refusing to greet somebody is not a safety property, it is a bad product.
  { id: 'hello', division: 'paving',
    ask: 'hey there',
    expect: [
      { maxWords: 45, note: 'a greeting gets a sentence, not a briefing' },
      { avoid: /(do ?n.t|cannot|can.t|unable to).{0,30}(have|answer|see)/i,
        note: 'a greeting answered with a refusal reads as broken' },
      { avoid: /\$[\d,]/, note: 'nobody said hello to be handed a figure' },
    ] },
  { id: 'thanks', division: 'paving',
    ask: 'thanks, that helps',
    expect: [
      { maxWords: 30, note: 'an acknowledgement is not a prompt for a report' },
      { avoid: /\$[\d,]/, note: 'and not a prompt for figures either' },
    ] },
  { id: 'what-can-you-do', division: 'paving',
    ask: 'what can you actually tell me about here',
    expect: [
      { say: /purchase order|equipment|crew|employee|paperwork|document|cost code/i,
        note: 'the covers list is the honest answer and it is right there' },
    ] },
  // Written help now exists for the job pages, so the honest answer changed
  // from "I can't see the screen" to the actual answer.
  { id: 'where-is-po', division: 'paving',
    ask: 'walk me through where I click to add a new purchase order',
    expect: [
      { say: /purchase orders? tab/i, note: 'the help text says exactly this and it is checked against the page' },
      { say: /new po/i, note: 'and names the button' },
    ] },
  { id: 'who-can-see-rates', division: 'paving',
    ask: 'why cant my foreman see what the crew is paid',
    expect: [
      { say: /level ?3|admin|manage lists|permission/i,
        note: 'rates live behind the Admin menu, which is hidden below level3 — the same rule the digest enforces' },
    ] },
  // The line the help must not be allowed to cross: three true sentences
  // about a tab inviting a confident fourth.
  { id: 'help-stops-where-written', division: 'paving',
    ask: 'what keyboard shortcut jumps to the next cost code',
    expect: [
      { say: /(not|do ?n.t|cannot|can.t).{0,60}(written|know|have|see)/i,
        note: 'nothing is written about shortcuts, and inventing one is the failure this guards' },
    ] },
  // A page with nothing written up gets no help tool at all.
  { id: 'no-invented-ui', division: 'quarry',
    ask: 'walk me through where I click to record a crushing day',
    expect: [
      { say: /(cannot|can.t|do ?n.t).{0,60}(see|walk|screen|interface|written)/i,
        note: 'no help is written for the quarry page, so the honest answer is the only one' },
    ] },
  // Arithmetic on digest figures is the answer, not an estimate.
  { id: 'sum-is-not-a-guess', division: 'paving',
    ask: 'what do those jobs come to altogether',
    expect: [
      { avoid: /(cannot|can.t|do ?n.t).{0,40}(add|total|sum|calculat)/i,
        note: 'adding up figures that are in the digest is arithmetic, not extrapolation' },
    ] },

  // ── Being a colleague rather than a lookup ─────────────────────────────
  // The complaint behind these: it fetched the number and stopped. Every case
  // here is answerable from a digest already in hand, and the failure is
  // declining to do the thinking rather than getting a figure wrong.
  { id: 'explain-the-metric', division: 'paving',
    ask: 'what does projected profit actually mean here',
    expect: [
      { say: /contract.{0,40}(minus|less).{0,40}projected|projected final cost/i,
        note: 'it is a question about the metric, and the definition is in the limits' },
      { avoid: /^\s*\$[\d,]+/, note: 'answering a definition with a figure is answering a different question' },
    ] },
  { id: 'why-two-differ', division: 'paving',
    ask: 'why is projected profit different from actual profit on these',
    expect: [
      { say: /(to date|so far|spent|remaining|final)/i,
        note: 'one counts cost so far and the other the projected final — the limits say so' },
    ] },
  { id: 'have-a-view', division: 'paving',
    ask: 'which of these jobs should I be worried about, and why',
    expect: [
      { say: /because|since|driven by|the reason/i, note: 'a reason, not a list' },
      { avoid: /(cannot|can.t|unable to|not able to).{0,40}(say|judge|advise|recommend|tell you which)/i,
        note: 'deflecting a judgement it can make from the digest is the failure here' },
    ] },
  { id: 'show-the-working', division: 'paving',
    ask: 'what is the total projected profit and what is driving it',
    expect: [
      { say: /\$[\d,]/, note: 'the total is a sum of figures in the digest' },
      { say: /(most of|driven|largest|biggest|accounts for|carrying)/i,
        note: 'a total broken into what makes it up is more useful than the total' },
    ] },
  { id: 'name-what-is-missing', division: 'paving',
    ask: 'how has our profit trended over the last six months',
    expect: [
      { say: /(no|not).{0,60}(history|over time|month|trend|snapshot|captured)/i,
        note: 'nothing captures job facts over time, and naming that is the useful half' },
      { avoid: /\b(up|down|improv\w+|declin\w+|worse|better)\b.{0,30}\bsince\b/i,
        note: 'a trend described from a single snapshot is invented' },
    ] },

  // ── Tone. The most likely real complaint. ──────────────────────────────
  { id: 'brevity', division: 'paving',
    ask: 'what was the profit on the last 5 projects',
    expect: [{ maxWords: 160, note: 'a chat panel answer that runs past a screen is one nobody reads' }] },
];

// ── Runner ─────────────────────────────────────────────────────────────────
function fail(msg) { console.error(msg); process.exit(1); }

if (LIST) {
  console.log(`\n${CASES.length} cases\n`);
  for (const c of CASES) {
    console.log(`  ${c.id.padEnd(22)} [${c.division}]  ${c.ask}`);
    for (const e of c.expect) console.log(`      ${e.say ? 'must say  ' : e.avoid ? 'must avoid' : 'limit     '} ${e.note}`);
  }
  console.log(`\nRun with --yes to execute. Roughly $${(CASES.length * 0.07).toFixed(2)} a run.\n`);
  process.exit(0);
}

if (!CONFIRM) {
  fail('\nThis calls the real model against real data and costs money.\n'
     + `  ${CASES.length} cases, roughly $${(CASES.length * 0.07).toFixed(2)} a run.\n\n`
     + '  node scripts/eval-mathis.js --list    read the set, spend nothing\n'
     + '  node scripts/eval-mathis.js --yes     run it\n');
}

for (const v of ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'JWT_SECRET', 'MATHIS_EVAL_USER', 'MATHIS_EVAL_COMPANY']) {
  if (!process.env[v]) {
    fail(`\n${v} is not set.\n\n`
       + '  This has to run against a real database and a real user, because an\n'
       + '  eval over fixtures would only measure whether Mathis can read two\n'
       + '  fake paving jobs. Set:\n\n'
       + '    DATABASE_URL         a real (ideally read-only) connection\n'
       + '    ANTHROPIC_API_KEY    the same key the app uses\n'
       + '    JWT_SECRET           the app\'s signing key\n'
       + '    MATHIS_EVAL_USER     a user id in that database\n'
       + '    MATHIS_EVAL_COMPANY  their company code\n');
  }
}

const handler = require(path.join(__dirname, '../api/ai/mathis.js'));

function tokenFor() {
  return jwt.sign({
    userId: Number(process.env.MATHIS_EVAL_USER),
    username: process.env.MATHIS_EVAL_USERNAME || 'eval',
    companyCode: String(process.env.MATHIS_EVAL_COMPANY).toUpperCase(),
  }, process.env.JWT_SECRET);
}

function mkRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = () => {};
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

async function ask(c) {
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor()}`, accept: 'application/json' },
    body: { message: c.ask, division: c.division },
    query: {},
  };
  const res = mkRes();
  await handler(req, res);
  return res;
}

function judge(c, answer) {
  const failures = [];
  for (const e of c.expect) {
    if (e.say && !e.say.test(answer))    failures.push(`did not say what it had to — ${e.note}`);
    if (e.avoid && e.avoid.test(answer)) failures.push(`said what it must not — ${e.note}`);
    if (e.maxWords) {
      const n = answer.trim().split(/\s+/).length;
      if (n > e.maxWords) failures.push(`${n} words, over ${e.maxWords} — ${e.note}`);
    }
  }
  return failures;
}

(async () => {
  const only = ONLY ? CASES.filter(c => c.id.includes(ONLY) || c.division === ONLY) : CASES;
  if (!only.length) fail(`\nNothing matches --only ${ONLY}\n`);

  console.log(`\nMathis eval — ${only.length} case${only.length === 1 ? '' : 's'}, real model, real data\n`);
  let passed = 0, failed = 0, skipped = 0;
  const bad = [];

  for (const c of only) {
    process.stdout.write(`  ${c.id.padEnd(22)} `);
    let res;
    try { res = await ask(c); }
    catch (err) { console.log(`ERROR  ${err.message}`); failed++; continue; }

    if (res.statusCode === 403) {
      // Not a failure: the eval user simply does not hold this division, and
      // a refusal is the correct answer to a question they cannot ask.
      console.log('skip   (no access to this division)');
      skipped++;
      continue;
    }
    if (res.statusCode !== 200 || !res.body || !res.body.ok) {
      console.log(`ERROR  ${res.statusCode} ${(res.body && res.body.error) || ''}`);
      failed++;
      continue;
    }

    const answer = String(res.body.answer || '');
    const problems = judge(c, answer);
    if (!problems.length) {
      console.log('ok');
      passed++;
    } else {
      console.log('FAIL');
      problems.forEach(p => console.log(`      ${p}`));
      failed++;
      bad.push({ c, answer, problems });
    }
    if (VERBOSE) console.log(`      → ${answer.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  if (bad.length) {
    console.log('\n── what it actually said ──');
    for (const b of bad) {
      console.log(`\n${b.c.id}: "${b.c.ask}"`);
      console.log(b.answer.replace(/^/gm, '  '));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('A failure here is usually the system prompt, not the data — check the');
  console.log('digest first (the answer is built from one), then the wording.\n');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('\nharness error:', err); process.exit(1); });
