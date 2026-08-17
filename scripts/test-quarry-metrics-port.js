'use strict';

/**
 * api/lib/quarry-metrics is a PORT of quarry.html's arithmetic — the executive
 * report exists to agree with the Quarry page, so a port that drifts is worse
 * than no port at all. This test runs the port over the same fixture
 * scripts/test-quarry-inventory.js uses against the real page, and asserts the
 * same answers.
 *
 * That fixture's expected numbers were derived from the page itself, so
 * agreement here is agreement with the page. It also happens to exercise the
 * cases most likely to drift: an as-of cutoff, a pit-level opening count that
 * excludes earlier sales, undated and future-dated rows, a configured
 * jaws→screen loss on one pit and none on the other, and the legacy per-pit
 * openings map that quarry.html migrates on load.
 *
 * Run: node scripts/test-quarry-metrics-port.js
 */

const {
  crushCalc, dailyCalc, salesAmount,
  lossHelpers, royaltyHelpers, fixedHelpers,
  computeInventory, computeByLocation, computeBreakeven, normalizeOpenings,
} = require('../api/lib/quarry-metrics');

let passed = 0, failed = 0;
const assert = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;
const section = t => console.log(`\n[${t}]`);

// ── The fixture from scripts/test-quarry-inventory.js, verbatim ────────────
const AS_OF = '2026-07-30';

const CRUSH = [
  // 10 loads × 20 t = 200 t to crusher → 180 sellable at 10% loss.
  // Cost 30×8 + 50×4 = 440.
  { id: 'c1', date: '2026-03-10', locationName: 'Homer City',   productName: '2A Modified', hourlyRate: 30, hours: 8,
    fuelGallons: 50, fuelCost: 4, loadsToCrusher: 10, tonsPerLoad: 20, hoursCrushing: 6 },
  // 5 loads × 20 t = 100 t, no loss configured → 100 sellable.
  { id: 'c2', date: '2026-04-05', locationName: 'McGees Mills', productName: '2A Modified', hourlyRate: 0,  hours: 0,
    fuelGallons: 0,  fuelCost: 0, loadsToCrusher: 5,  tonsPerLoad: 20, hoursCrushing: 4 },
  // Dated past the As-Of cutoff → excluded from the balance.
  { id: 'c3', date: '2026-12-31', locationName: 'Homer City',   loadsToCrusher: 99, tonsPerLoad: 20 },
  // No date → excluded.
  { id: 'c4', date: '',           locationName: 'Homer City',   loadsToCrusher: 7,  tonsPerLoad: 20 },
];
const SALES = [
  { id: 's1', date: '2026-03-15', locationName: 'Homer City',   productName: '2A Modified', tons: 50, pricePerTon: 12 },
  { id: 's2', date: '2026-05-01', locationName: 'Homer City',   productName: 'Rip Rap',     tons: 30, pricePerTon: 10 },
  { id: 's3', date: '2026-04-10', locationName: 'McGees Mills', productName: '2A Modified', tons: 20, pricePerTon: 15 },
  // On/before Homer City's opening count → excluded, already inside the pile.
  { id: 's4', date: '2026-01-15', locationName: 'Homer City',   productName: 'Rip Rap',     tons: 40, pricePerTon: 9 },
];
// Legacy per-pit openings map — the shape quarry.html migrates as it loads.
const INVENTORY = {
  basis: 'final',
  openings: { 'Homer City': { tons: 500, asOf: '2026-01-31' } },
  adjustments: [
    { id: 'a1', date: '2026-06-01', locationName: 'Homer City', tons: -25, reason: 'Waste / Fines Removed' },
  ],
};
const LOSS_PCT = { 'Homer City': 10 };

// The page's answers, from that test's own expectations.
const EXPECT_HOMER  = 575;   // 500 + 180 − (50 + 30) − 25
const EXPECT_MCGEES = 80;    //   0 + 100 −  20

const loss = lossHelpers(LOSS_PCT);

// ──────────────────────────────────────────────────────────────────────────
section('the legacy per-pit openings map still yields its opening count');
const openings = normalizeOpenings(INVENTORY.openings);
assert('the map form migrates to one entry per pit',
  openings.length === 1 && openings[0].locationName === 'Homer City',
  JSON.stringify(openings));
assert('carrying its tons and its count date',
  openings.length === 1 && near(openings[0].tons, 500) && openings[0].asOf === '2026-01-31',
  JSON.stringify(openings));
assert('and an array of entries passes through untouched',
  normalizeOpenings([{ locationName: 'X', tons: 1 }]).length === 1);
assert('a zeroed entry with no count date is dropped, one with a date is kept',
  normalizeOpenings({ A: { tons: 0, asOf: '' } }).length === 0
  && normalizeOpenings({ A: { tons: 0, asOf: '2026-01-01' } }).length === 1);

// ──────────────────────────────────────────────────────────────────────────
section('the stockpile balance matches the page');
const inv = computeInventory({
  sales: SALES, crush: CRUSH, inventory: INVENTORY, cutoff: AS_OF, loss,
});
const homer  = inv.locations.find(e => e.name === 'Homer City');
const mcgees = inv.locations.find(e => e.name === 'McGees Mills');

assert(`Homer City on hand = ${EXPECT_HOMER}`,
  homer && near(homer.onHand, EXPECT_HOMER), `got ${homer && homer.onHand}`);
assert(`McGees Mills on hand = ${EXPECT_MCGEES}`,
  mcgees && near(mcgees.onHand, EXPECT_MCGEES), `got ${mcgees && mcgees.onHand}`);
assert('the division total is the two piles added up',
  near(inv.total.onHand, EXPECT_HOMER + EXPECT_MCGEES), `got ${inv.total.onHand}`);

assert('the 10% loss takes 200 tons crushed to 180 in the pile',
  homer && near(homer.produced, 180), `got ${homer && homer.produced}`);
assert('a pit with no loss configured banks every ton it crushed',
  mcgees && near(mcgees.produced, 100), `got ${mcgees && mcgees.produced}`);
assert('a sale dated on or before the opening count does not deplete the pile again',
  homer && near(homer.tonsSold, 80), `got ${homer && homer.tonsSold} (expected 50 + 30, not 120)`);
assert('a future-dated row is left out of the balance',
  homer && !near(homer.produced, 180 + 99 * 20));
assert('an undated row is left out too',
  homer && near(homer.produced, 180));
assert('an adjustment is applied',
  homer && near(homer.adjustments, -25), `got ${homer && homer.adjustments}`);

// ──────────────────────────────────────────────────────────────────────────
section('per-row arithmetic matches the page');
// Homer City crushing: 30×8 payroll + 50×4 fuel = 440, and 10 × 20 = 200 tons.
assert('crushing cost is payroll plus fuel',
  near(crushCalc(CRUSH[0]).totalCost, 440), `got ${crushCalc(CRUSH[0]).totalCost}`);
assert('estimated tons is loads × tons per load',
  near(crushCalc(CRUSH[0]).estimatedTons, 200));
assert('a daily row costs hours × rate plus gallons × price',
  near(dailyCalc({ hours: 10, rate: 50, fuelGallons: 20, ppg: 4 }).totalCost, 580));
assert('a sale is worth tons × price per ton',
  near(salesAmount(SALES[0]), 600));
assert('a half-entered sale with no price is worth nothing, not NaN',
  salesAmount({ tons: 10, pricePerTon: '' }) === 0);

// ──────────────────────────────────────────────────────────────────────────
section('performance by location matches the page');
const byLoc = computeByLocation({ sales: SALES, daily: [], crush: CRUSH, loss });
const lHomer  = byLoc.locations.find(e => e.name === 'Homer City');
const lMcgees = byLoc.locations.find(e => e.name === 'McGees Mills');

// This view has no as-of cutoff, so it counts every row: Homer City sells
// 50×12 + 30×10 + 40×9 = $1,260 over 120 tons.
assert('Homer City sales = $1,260 across every dated sale',
  lHomer && near(lHomer.totalSales, 1260), `got ${lHomer && lHomer.totalSales}`);
assert('Homer City cost = $440, its crushing only',
  lHomer && near(lHomer.totalCost, 440), `got ${lHomer && lHomer.totalCost}`);
assert('margin is sales less cost',
  lHomer && near(lHomer.grossMargin, 820), `got ${lHomer && lHomer.grossMargin}`);
// Cost / ton sold = 440 ÷ 120 = $3.67. Cost / ton (production) = 440 ÷ 2,320
// (200 + 99×20 + 7×20) — this view has no cutoff, so the future-dated and
// undated crushing rows count toward tonnage here even though the stockpile
// balance excluded them. That difference is the page's, not a bug: the balance
// is a point in time, this table is the year's activity.
assert('cost per ton sold divides total cost by tons sold',
  lHomer && near(lHomer.avgCostPerTonSold, 440 / 120), `got ${lHomer && lHomer.avgCostPerTonSold}`);
assert('cost per ton produced divides crushing cost by tons crushed',
  lHomer && near(lHomer.costPerTon, 440 / lHomer.tonsCrushed), `got ${lHomer && lHomer.costPerTon}`);
assert('the loss figure is reported for the pit that has one',
  lHomer && lHomer.hasLoss === true && near(lHomer.lossPct, 10));
assert('and reported as absent for the pit that does not',
  lMcgees && lMcgees.hasLoss === false);
assert('final screen tons apply that loss',
  lHomer && near(lHomer.finalScreenTons, lHomer.tonsCrushed * 0.9));

assert('the division total re-adds the raw sums rather than averaging averages',
  near(byLoc.total.totalSales, 1260 + 300)
  && near(byLoc.total.totalCost, 440)
  && near(byLoc.total.avgCostPerTonSold, 440 / (120 + 20)),
  `sales ${byLoc.total.totalSales}, cost/ton sold ${byLoc.total.avgCostPerTonSold}`);
assert('and its loss % is tonnage-weighted, not a mean of the pits',
  // Only Homer City has a figure entered, so the total reports none — the page's
  // rule is that every crushing pit must have one before a total loss is shown.
  byLoc.total.hasLoss === false,
  `hasLoss=${byLoc.total.hasLoss}`);

// ──────────────────────────────────────────────────────────────────────────
section('break-even matches the page');
// One pit, one owner at 10% on royalty-flagged rock, $1,000/month fixed.
const be = computeBreakeven({
  sales: SALES.filter(r => r.locationName === 'Homer City'),
  crush: CRUSH.filter(r => r.locationName === 'Homer City'),
  royalty: royaltyHelpers(
    { 'Homer City': [{ name: 'Owner', rate: 10, floor: 0 }] },
    { product: [{ id: 'p1', name: '2A Modified', royalty: true }] },
  ),
  fixed: fixedHelpers({ 'Homer City': { '2026-03': 1000, '2026-05': 1000 } }),
});
const beHomer = be.rows.find(r => r.name === 'Homer City');
// Price = 1,260 ÷ 120 = $10.50/ton. Royalty applies to the 2A Modified sale
// only (50 t × $12 = $600 → $60), so $60 ÷ 120 t = $0.50/ton. Variable cost is
// crushing 440 ÷ 2,320 tons crushed = $0.1897/ton.
assert('blended price per ton = $10.50',
  beHomer && near(beHomer.avgPrice, 10.5), `got ${beHomer && beHomer.avgPrice}`);
assert('royalty applies only to the flagged product',
  beHomer && near(beHomer.royaltyCost, 60), `got ${beHomer && beHomer.royaltyCost}`);
assert('royalty per ton spreads over every ton sold',
  beHomer && near(beHomer.royaltyPerTon, 0.5), `got ${beHomer && beHomer.royaltyPerTon}`);
assert('contribution is price less royalty less variable cost',
  beHomer && near(beHomer.contribution, 10.5 - 0.5 - 440 / beHomer.tonsCrushed),
  `got ${beHomer && beHomer.contribution}`);
assert('fixed cost is averaged over the months it was entered for',
  beHomer && near(beHomer.monthlyFixed, 1000), `got ${beHomer && beHomer.monthlyFixed}`);
assert('break-even tons is fixed cost over contribution',
  beHomer && near(beHomer.breakEvenTons, 1000 / beHomer.contribution, 0.01),
  `got ${beHomer && beHomer.breakEvenTons}`);
assert('a pit that sold nothing this period reports no contribution rather than zero',
  computeBreakeven({
    sales: [], crush: [],
    royalty: royaltyHelpers({}, {}),
    fixed: fixedHelpers({ 'Idle Pit': { '2026-01': 500 } }),
  }).rows[0].contribution === null);

console.log('');
if (failed) {
  console.error(`❌ ${failed} of ${passed + failed} assertions failed`);
  process.exit(1);
}
console.log(`✅ all ${passed} assertions passed — the port agrees with quarry.html`);
