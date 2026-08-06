#!/usr/bin/env node
'use strict';
/**
 * Tests for the cost-code percent complete on the bid view's green group header.
 *
 * Run: node scripts/test-bid-group-pct.js
 *
 * The green row above each set of sub codes now carries the roll-up of those
 * sub codes' progress. The rules it has to hold to:
 *
 *   1. Every sub code under the cost code marked complete → exactly 100%,
 *      regardless of what the quantities say. A line signed off at 57.5% of its
 *      bid quantity is done; the crew isn't going back.
 *   2. Otherwise the unfinished sub codes count their QTY COMPLETED figure
 *      (running qty ÷ bid qty), and the sub codes are weighted by bid dollars —
 *      a $67k line at half done leaves far more work than a $1k line at half
 *      done, and a plain average can't tell those apart.
 *   3. A single over-run sub code can't carry the group past done: 105% of one
 *      line is still just that one line finished.
 *   4. Only rule 1 may read 100%. Quantities all in but a sub code not yet
 *      signed off holds at 99.9, so 100% keeps meaning "closed out".
 *   5. Lines carrying no bid dollars (Mobilization, Walkway Prep) still count,
 *      but with a fallback weight of 1 — they can't outvote the money.
 *
 * The fixtures are the real cost codes from the Franklin Regional Tennis Court
 * job, so the expectations are checkable against the screen.
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

/* Lift one top-level function out of the page by brace-matching its body.
   Brace matching starts after the parameter list, not at the first `{` in the
   source — renderBidTable(projId, opts = {}) has a brace in its signature, and
   matching from there returns an empty body that quietly passes every check. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let paren = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

/* Evaluate the real bidGroupPct / _bidGroupPctHTML out of the page, with the two
   lookups they lean on stubbed off the fixtures. `complete` on a fixture stands
   in for bidItemComplete() — whether the Schedule tab flag or the Construction
   Schedule marked it done doesn't change the roll-up. */
function load(file) {
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const body = `
    let _proj = null;
    function setProj(p) { _proj = p; }
    function getProj() { return _proj; }
    function bidItemComplete(b)      { return !!b.complete; }
    function runningQtyForBidItem(b) { return parseFloat(b.running) || 0; }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    ${extractFunction(src, 'bidGroupPct')}
    ${extractFunction(src, 'bidProjectPct')}
    ${extractFunction(src, '_bidGroupPctHTML')}
    return { bidGroupPct, bidProjectPct, _bidGroupPctHTML, setProj };
  `;
  return new Function(body)();
}

// ── Fixtures — Franklin Regional Tennis Court ────────────────────────────────
const TENNIS_CONCRETE = [
  { sub_code: 'Concrete Curb 12inch', quantity: 386, unit_cost: 43.26, running: 386, complete: true },
  { sub_code: 'Concrete Curb 30inch', quantity: 386, unit_cost: 125,   running: 384, complete: true },
];
const TENNIS_PAVING = [
  { sub_code: 'Tennis Court - 2" 4.75MM', quantity: 3521, unit_cost: 19.03, running: 3699.81 },
  { sub_code: 'Walkway Prep',             quantity: 0,    unit_cost: 0,     running: 0 },
  { sub_code: 'Walkway Paving 9.5MM',     quantity: 0,    unit_cost: 0,     running: 0 },
];
// Signed off at 57.5% of its bid quantity — the group is still done.
const TENNIS_SURFACE = [
  { sub_code: 'Surface Coatings/Line Markings', quantity: 3521, unit_cost: 13.42, running: 2026, complete: true },
];

for (const file of FILES) {
  console.log(`\n[${file}]`);
  const { bidGroupPct, bidProjectPct, _bidGroupPctHTML, setProj } = load(file);
  const pctOf = items => bidGroupPct(items, 'p1');
  // bidProjectPct groups by cost_code itself, so fixtures carry one.
  const projectPct = groups => {
    const bidItems = [];
    Object.entries(groups).forEach(([cc, items]) =>
      items.forEach(b => bidItems.push(Object.assign({ cost_code: cc }, b))));
    setProj({ id: 'p1', bidItems });
    return bidProjectPct('p1');
  };

  // ── Rule 1: every sub code complete → 100% ────────────────────────────────
  const concrete = pctOf(TENNIS_CONCRETE);
  assert('Tennis Concrete — both sub codes complete → 100%',
    concrete.allDone === true && concrete.pct === 100, `got ${concrete.pct}`);
  assert('  …and 99.5% of the bid qty on one of them does not hold it back',
    concrete.done === 2 && concrete.total === 2);

  const surface = pctOf(TENNIS_SURFACE);
  assert('Surface Coating — signed off at 57.5% of bid qty → still 100%',
    surface.allDone === true && surface.pct === 100, `got ${surface.pct}`);

  // ── Rule 2: unfinished lines count qty completed, weighted by bid dollars ──
  const mixed = pctOf([
    { quantity: 100, unit_cost: 10, running: 50 },   //   $1,000 line, 50% done
    { quantity: 100, unit_cost: 90, running: 0 },    //   $9,000 line, untouched
  ]);
  assert('a cheap half-done line + an untouched expensive one → 5%, not 25%',
    near(mixed.pct, 5), `got ${mixed.pct}`);

  const someDone = pctOf([
    { quantity: 100, unit_cost: 10, running: 0, complete: true },  // done
    { quantity: 100, unit_cost: 10, running: 25 },                 // 25% by qty
  ]);
  assert('one of two equal lines complete, the other 25% by qty → 62.5%',
    near(someDone.pct, 62.5) && someDone.done === 1 && someDone.total === 2, `got ${someDone.pct}`);

  assert('a complete line counts 100% even with no quantity logged against it',
    near(pctOf([{ quantity: 100, unit_cost: 10, running: 0, complete: true }]).pct, 100));

  // ── Rule 3: an over-run line is capped at its own 100% ─────────────────────
  const overrun = pctOf([
    { quantity: 100, unit_cost: 10, running: 200 },  // 200% of bid qty
    { quantity: 100, unit_cost: 10, running: 0 },
  ]);
  assert('a 200% over-run line cannot carry an untouched line → 50%, not 100%',
    near(overrun.pct, 50), `got ${overrun.pct}`);

  // ── Rule 4: only "all complete" reads 100 ──────────────────────────────────
  const allQtyIn = pctOf([
    { quantity: 100, unit_cost: 10, running: 100 },
    { quantity: 100, unit_cost: 10, running: 100 },
  ]);
  assert('quantities all in but nothing signed off → 99.9%, not 100%',
    allQtyIn.pct === 99.9 && allQtyIn.allDone === false, `got ${allQtyIn.pct}`);

  // ── Rule 5: bid-less lines register but do not outvote the money ───────────
  const paving = pctOf(TENNIS_PAVING);
  assert('Tennis Paving — the $67k line is in, two bid-less lines are not → >99%',
    paving.pct > 99 && paving.pct < 100, `got ${paving.pct}`);
  assert('  …and the bid-less lines still show as not complete (0/3)',
    paving.done === 0 && paving.total === 3);
  assert('a group of nothing but bid-less lines averages them evenly',
    near(pctOf([
      { quantity: 0, unit_cost: 0, running: 0, complete: true },
      { quantity: 0, unit_cost: 0, running: 0 },
    ]).pct, 50));

  // ── Change orders move the denominator, same as the QTY COMPLETED cell ─────
  assert('a +100 change order on a 100 bid puts 100 logged units at 50%',
    near(pctOf([{ quantity: 100, unit_cost: 10, running: 100,
      change_orders: [{ qty_delta: 100 }] }]).pct, 50));
  assert('a change order that drives the bid negative does not invert the weight',
    pctOf([
      { quantity: 100, unit_cost: 10, running: 0, change_orders: [{ qty_delta: -300 }] },
      { quantity: 100, unit_cost: 10, running: 100 },
    ]).pct > 0);

  // ── Degenerate input ──────────────────────────────────────────────────────
  assert('an empty group has nothing to measure → null',
    pctOf([]) === null && pctOf(null) === null);
  assert('a group of untouched lines → 0%',
    pctOf([{ quantity: 100, unit_cost: 10, running: 0 }]).pct === 0);

  // ── The badge ─────────────────────────────────────────────────────────────
  const doneHTML = _bidGroupPctHTML(concrete);
  assert('badge renders the percent, the fill width and the done count',
    /100\.0% complete/.test(doneHTML) && /width:100\.0%/.test(doneHTML) && /2\/2 sub codes done/.test(doneHTML),
    doneHTML);
  assert('badge is green once every sub code is complete',
    /class="bid-grp-pct gp-done"/.test(doneHTML));
  assert('badge is blue while work is under way',
    /class="bid-grp-pct gp-active"/.test(_bidGroupPctHTML(mixed)));
  assert('badge is muted before anything is logged',
    /class="bid-grp-pct gp-none"/.test(_bidGroupPctHTML(pctOf([{ quantity: 100, unit_cost: 10, running: 0 }]))));
  assert('badge explains the weighting in its tooltip',
    /weighted by its bid dollars/.test(_bidGroupPctHTML(mixed)));
  assert('a group with nothing to measure renders no badge',
    _bidGroupPctHTML(null) === '');
  assert('the tooltip escapes into the title attribute safely',
    !/title="[^"]*"[^>]*"/.test(_bidGroupPctHTML(mixed).split('\n')[0]));

  // ── The project roll-up in the summary bar ────────────────────────────────
  const franklin = projectPct({
    'Tennis Paving':   TENNIS_PAVING,
    'Tennis Concrete': TENNIS_CONCRETE,
    'Tennis Surface Coating/Line': TENNIS_SURFACE,
  });
  assert('project percent counts cost codes, not sub codes',
    franklin.total === 3 && franklin.done === 2, `got ${franklin.done}/${franklin.total}`);
  assert('  …and lands between its lowest and highest cost code',
    franklin.pct > 99 && franklin.pct <= 99.9, `got ${franklin.pct}`);

  assert('every cost code signed off → the project reads 100%',
    projectPct({ A: TENNIS_CONCRETE, B: TENNIS_SURFACE }).pct === 100);
  assert('one cost code short of signed off → 99.9%, not 100%',
    projectPct({ A: TENNIS_CONCRETE, B: [{ quantity: 1, unit_cost: 1, running: 1 }] }).pct === 99.9);

  // A cost code whose sub codes are all complete contributes a flat 100 up here
  // too — rolling straight to the sub codes would re-litigate that and read
  // lower than the green row on screen.
  const signedOffLow = projectPct({
    'Surface Coating': TENNIS_SURFACE,                                  // done at 57.5% of qty
    'Sitework':        [{ quantity: 100, unit_cost: 472.55, running: 0 }],  // same bid $, untouched
  });
  assert('a cost code signed off below its bid qty still contributes 100 to the project',
    near(signedOffLow.pct, 50, 0.6), `got ${signedOffLow.pct}`);

  const weighted = projectPct({
    Small: [{ quantity: 100, unit_cost: 10, running: 100 }],   //  $1,000 line, 100% by qty
    Big:   [{ quantity: 100, unit_cost: 90, running: 0 }],     //  $9,000 line, untouched
  });
  assert('cost codes are weighted by bid dollars, not counted evenly',
    near(weighted.pct, 10), `got ${weighted.pct}`);

  assert('a project with no bid items has nothing to measure → null',
    projectPct({}) === null);

  // ── Wiring: the badge is on the green header row, in both table modes ──────
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const render = extractFunction(src, 'renderBidTable');
  assert('renderBidTable rolls each group up once, and reuses it for both rows',
    (render.match(/const gPct\s+= bidGroupPct\(visItems, projId\);/g) || []).length === 1 &&
    (render.match(/_bidGroupPctHTML\(gPct\)/g) || []).length === 1);
  assert('  …and drops it into both the editable and readonly headers',
    (render.match(/\$\{gPctHTML\}/g) || []).length === 2);
  assert('  …from the visible sub codes, so it agrees with the group subtotal',
    (render.match(/const visItems = scFilter/g) || []).length === 1 &&
    render.indexOf('const visItems = scFilter') < render.indexOf('// ── Group header ──'));
  assert('the badge styles ship with the page',
    /\.bid-grp-pct\.gp-done/.test(src) && /\.bid-grp-pct-bar i/.test(src));

  /* The group subtotal row repeats the percent in its own QTY COMPLETED cell.
     The two layouts order their columns differently, so the cell lands in a
     different slot in each — build the real row and count to it. A miscount
     prints the percent under Unit Cost, where it still looks like a number. */
  const totalCellsFor = ro => {
    const s = render.indexOf('const totalCells = ');
    const e = render.indexOf('const totalLabel =', s);
    return new Function('readonly', `
      const _dashCell = '<td class="bid-calc">—</td>';
      const gPctCell  = '<td class="bid-calc" data-pct="1">62.5%</td>';
      const gBidTotal = 1000, gActual = 900, gCumHrs = 10, gProj = 950, gEstHrs = 5;
      const gDiffCls = 'a', gDiffTxt = 'b', gProjCls = 'c';
      const fmt = n => String(n), qfmt = n => String(n);
      ${render.slice(s, e)}
      return totalCells;`)(ro);
  };
  const cellsOf = html => html.split('<td').slice(1);
  const pctSlot = html => cellsOf(html).findIndex(c => c.startsWith(' class="bid-calc" data-pct'));

  const roCells = cellsOf(totalCellsFor(true));
  const edCells = cellsOf(totalCellsFor(false));
  assert('total row: the percent sits under Qty Completed in the readonly table',
    pctSlot(totalCellsFor(true)) === 4, `slot ${pctSlot(totalCellsFor(true))}`);
  assert('total row: …and one column earlier in the editable table',
    pctSlot(totalCellsFor(false)) === 3, `slot ${pctSlot(totalCellsFor(false))}`);
  assert('total row: the cell count is unchanged, so nothing downstream shifts',
    roCells.length === 13 && edCells.length === 13 + (/gEstHrs/.test(render) ? 3 : 2),
    `${roCells.length} readonly / ${edCells.length} editable`);
  assert('total row: Cost Total still follows the seven leading cells',
    roCells[7].includes('1000') && edCells[7].includes('1000'));

  /* The dashboard table declared 13 headers over 14 body cells, so every
     column past Sub Code sat under the previous header's label and the last
     had none — which put the group percent under "Running Unit Cost". Header,
     body, footer and the group header's colspan all have to agree. */
  const dashThead = src.slice(src.lastIndexOf('<thead>', src.indexOf('<tbody id="dash-btbody-')),
                              src.indexOf('<tbody id="dash-btbody-'));
  const roChildTpl = render.slice(render.indexOf('childTr.innerHTML = readonly'),
                                  render.indexOf(': `<td class="bid-del"'));
  const tdsIn = s => (s.match(/<td[ >]/g) || []).length;
  const calcCells = name => {
    const a = render.indexOf(`const ${name} = \``);
    return tdsIn(render.slice(a, render.indexOf('`;', a)));
  };
  const roBodyCells = tdsIn(roChildTpl) + calcCells('calcCellsA') + calcCells('calcCellsB');
  assert('dashboard: one header per readonly body cell',
    (dashThead.match(/<th[ >]/g) || []).length === roBodyCells, `${(dashThead.match(/<th[ >]/g)||[]).length} th / ${roBodyCells} td`);
  assert('dashboard: the Unit header sits between Sub Code and Bid Qty, matching the row',
    /Sub Code<\/th>\s*<th[^>]*>Unit<\/th>\s*<th[^>]*>Bid Qty/.test(dashThead));
  assert('dashboard: the group header colspan matches the real width',
    new RegExp(`const COLS\\s+= readonly \\? ${roBodyCells} :`).test(render));
  assert('dashboard: the footer still emits one cell per column',
    tdsIn(src.slice(src.indexOf('const cells = `'), src.indexOf('`;', src.indexOf('const cells = `')))) === roBodyCells);

  /* The printed and emailed report is built by exportBidPDF — same roll-up, or
     the PDF disagrees with the page it was printed from. */
  const pdf = extractFunction(src, 'exportBidPDF');
  const pdfHeads = (() => {
    const t = pdf.indexOf('<thead><tr>'), e = pdf.indexOf('</tr></thead>', t);
    return [...pdf.slice(t, e).matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(m => m[1]);
  })();
  assert('report: the cost-code header carries the percent and the done count',
    /bidGroupPct\(gItems, projId\)/.test(pdf) && /% complete<\/span>/.test(pdf));
  assert('report: its colspan matches the table width, so there is no phantom column',
    new RegExp(`<tr class="group-hdr"><td colspan="${pdfHeads.length}">`).test(pdf));
  assert('report: the group subtotal prints the percent under Qty Completed',
    pdfHeads[4] === 'Qty Completed' &&
    /\$\{r\(dash\)\}\$\{r\(dash\)\}\$\{r\(dash\)\}\$\{r\(gPct \? gPct\.pct\.toFixed\(1\) \+ '%' : dash\)\}/.test(pdf));
  assert('report: the grand totals row prints the project percent in the same column',
    /\$\{r\(dash\)\}\$\{r\(dash\)\}\$\{r\(dash\)\}\$\{r\(grandPct \? grandPct\.pct\.toFixed\(1\) \+ '%' : dash\)\}/.test(pdf));
  assert('report: the summary bar shows Project Complete like the screen does',
    /const grandPct\s+= bidProjectPct\(projId\);/.test(pdf) &&
    /sqft-label">Project Complete</.test(pdf));
  assert('report: the project percent is unfiltered, matching the grand totals beside it',
    !/bidProjectPct\(projId, ?visGroupOrder/.test(pdf));

  // ── Wiring: the project roll-up in the fullscreen summary bar ─────────────
  const footer = extractFunction(src, 'renderBidFooter');
  assert('the summary bar computes the project percent from the cost codes',
    /bidProjectPct\(projId\)/.test(footer));
  assert('  …and shows it alongside Projected Profit',
    /fmet\('Project Complete'/.test(footer) &&
    footer.indexOf("fmet('Projected Profit'") < footer.indexOf("fmet('Project Complete'"));
  assert('  …with the cost-code count and an explanation on hover',
    /cost codes<\/span>/.test(footer) && /title="\$\{esc\(gpctTip\)\}"/.test(footer));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
