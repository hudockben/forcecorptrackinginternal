'use strict';

// Quarry roll-up arithmetic, ported from quarry.html so the executive report
// reports the pit numbers the Quarry page reports.
//
// Everything here is a pure function over the blob arrays the Quarry page keeps
// in app_data — no SQL, no dates read from the clock except the ones passed in.
// The intent is a line-for-line correspondence with the page:
//
//   salesAmount        ← homeRowSales()
//   dailyCalc          ← dailyCalc()
//   crushCalc          ← crushCalc()
//   computeInventory   ← computeInventory({ applyFilters: false })
//   computeByLocation  ← computeByLocation()      (Performance by Location)
//   computeBreakeven   ← computeBreakeven('home')
//
// The Quarry Home tab defaults its Year filter to the current year, so the
// caller passes that year and every figure here is scoped to it — except the
// stockpile balance, which is a point in time and balances THROUGH the cutoff
// instead (a pile is what is sitting there, not a year's worth of activity).

const NO_LOCATION = '— No location —';
const INV_RATE_WINDOW_DAYS = 90;  // trailing window behind the sales-rate KPI
const INV_LOW_DAYS         = 14;  // days of supply below which a pit reads "low"

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoDate = d => {
  const s = String(d || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
};
const rowYear = d => {
  const m = String(d || '').match(/^(\d{4})/);
  return m ? m[1] : null;
};
const locKey = name => String(name || '').trim() || NO_LOCATION;

// Month key tolerant of both ISO and US-style dates, as on the page.
function monthKey(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  let m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

function shiftDays(iso, days) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Per-row cost / revenue ───────────────────────────────────────────
const salesAmount = r => num(r && r.tons) * num(r && r.pricePerTon);
const dailyCalc   = r => ({ totalCost: num(r && r.hours) * num(r && r.rate)
                                     + num(r && r.fuelGallons) * num(r && r.ppg) });
function crushCalc(r) {
  const totalCost     = num(r && r.hourlyRate) * num(r && r.hours)
                      + num(r && r.fuelGallons) * num(r && r.fuelCost);
  const estimatedTons = num(r && r.loadsToCrusher) * num(r && r.tonsPerLoad);
  return { totalCost, estimatedTons };
}

// ── Jaws → final-screen loss, per pit ────────────────────────────────
// A pit with no figure entered is treated as 0% loss, but "entered" is tracked
// separately: the page shows "—" rather than 0% so a missing setting can't read
// as a perfect screen.
function lossHelpers(lossPct) {
  const map = (lossPct && typeof lossPct === 'object') ? lossPct : {};
  const pctFor  = loc => {
    const v = Number(map[String(loc || '').trim()]);
    return (Number.isFinite(v) && v > 0) ? v : 0;
  };
  const hasFor  = loc => {
    const v = Number(map[String(loc || '').trim()]);
    return Number.isFinite(v) && v > 0;
  };
  const finalFor = (tons, loc) => {
    const t = Number(tons);
    if (!Number.isFinite(t) || t <= 0) return 0;
    return t * (1 - pctFor(loc) / 100);
  };
  return { pctFor, hasFor, finalFor };
}

// ── Royalty ──────────────────────────────────────────────────────────
// Each owner on a pit is paid the greater of (rate% of the sale) or ($floor per
// ton), stacked, and only on products flagged royalty-bearing in Manage Lists.
// Legacy blobs stored a bare percentage per pit.
function royaltyHelpers(royalty, lists) {
  const byPit = (royalty && typeof royalty === 'object' && !Array.isArray(royalty)) ? royalty : {};
  const ownersFor = loc => {
    const v = byPit[loc];
    if (Array.isArray(v)) return v;
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? [{ rate: n, floor: 0 }] : [];
  };

  const ids = new Set(), names = new Set();
  const products = (lists && Array.isArray(lists.product)) ? lists.product : [];
  for (const p of products) {
    if (!p || !p.royalty) continue;
    if (p.id != null && p.id !== '') ids.add(String(p.id));
    const nm = String(p.name || '').trim().toLowerCase();
    if (nm) names.add(nm);
  }
  const rowBears = r => {
    if (r && r.productId != null && r.productId !== '' && ids.has(String(r.productId))) return true;
    const nm = String((r && r.productName) || '').trim().toLowerCase();
    return nm !== '' && names.has(nm);
  };

  // No price means no sale value, so no royalty — otherwise the per-ton floor
  // would charge against $0 of revenue on a half-entered row.
  const forSale = (loc, tons, pricePerTon) => {
    const t = Number(tons);
    if (!Number.isFinite(t) || t <= 0) return 0;
    const price = Number(pricePerTon);
    if (!Number.isFinite(price) || price <= 0) return 0;
    let total = 0;
    for (const o of ownersFor(loc)) {
      total += Math.max(price * (Number(o && o.rate) || 0) / 100, Number(o && o.floor) || 0) * t;
    }
    return total;
  };
  return { rowBears, forSale };
}

// ── Monthly fixed cost ───────────────────────────────────────────────
// A pit's fixed cost is the average of the per-month figures entered for it,
// restricted to the months it was actually active — entries for other months or
// years must not drag the average down.
function fixedHelpers(monthlyFixed) {
  const map = (monthlyFixed && typeof monthlyFixed === 'object') ? monthlyFixed : {};
  const avgOverAll = scope => {
    const m = map[scope];
    if (!m || typeof m !== 'object') return 0;
    const vals = Object.keys(m).map(k => Number(m[k])).filter(v => Number.isFinite(v) && v > 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const avgOverMonths = (scope, monthsSet) => {
    const m = map[scope];
    if (!m || typeof m !== 'object' || !monthsSet || !monthsSet.size) return 0;
    const vals = [];
    monthsSet.forEach(mk => { const v = Number(m[mk]); if (Number.isFinite(v) && v > 0) vals.push(v); });
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const pitScopes = () => Object.keys(map).filter(s => s && s !== 'all' && s !== NO_LOCATION);
  return { avgOverAll, avgOverMonths, pitScopes };
}

// ── Stockpile balance ────────────────────────────────────────────────
// Openings are rolled up per pit. The count date is the LATEST across the pit's
// entries and applies to every row at that pit whatever its product — "we
// counted the yard that day" has to exclude everything before it, or a sale
// dated before the count would deplete the pile twice.
// The blob's openings arrived in two shapes over time. quarry.html migrates the
// original per-pit map — { '<pit>': { tons, asOf } }, and a bare-number variant —
// into per-row entries as it loads, so a company that has not re-saved its
// inventory since still shows its opening counts on the page. Reading only the
// array form here would silently drop those piles from the report.
function normalizeOpenings(openings) {
  if (Array.isArray(openings)) return openings;
  if (!openings || typeof openings !== 'object') return [];
  const out = [];
  for (const k of Object.keys(openings)) {
    const loc = String(k).trim();
    if (!loc) continue;
    const raw = openings[k];
    const obj = (raw && typeof raw === 'object') ? raw : { tons: raw, asOf: '' };
    const tons = Math.round(Number(obj.tons) * 100) / 100;
    if (!Number.isFinite(tons)) continue;
    const asOf = (typeof obj.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.asOf)) ? obj.asOf : '';
    // A zeroed entry is kept only when it still carries an as-of cutoff, which
    // is a real instruction: "the pile was empty when we counted on this date".
    if (tons !== 0 || asOf) out.push({ locationName: loc, tons, asOf });
  }
  return out;
}

function openingIndex(openings) {
  const byLoc = new Map();
  for (const o of normalizeOpenings(openings)) {
    if (!o) continue;
    const loc = locKey(o.locationName);
    if (!byLoc.has(loc)) byLoc.set(loc, { tons: 0, asOf: '' });
    const e = byLoc.get(loc);
    if (o.asOf && o.asOf > e.asOf) e.asOf = o.asOf;
    const t = Number(o.tons);
    if (Number.isFinite(t) && t !== 0) e.tons += t;
  }
  return byLoc;
}

const EMPTY_OPENING = { tons: 0, asOf: '' };

// A row lands in the balance when it is dated, falls after the pit's opening
// count, and is on or before the cutoff. ISO dates sort as strings.
function rowInWindow(dateStr, openingAsOf, cutoff) {
  const d = isoDate(dateStr);
  if (!d) return false;
  if (openingAsOf && d <= openingAsOf) return false;
  if (cutoff && d > cutoff) return false;
  return true;
}

function stockStatus(onHand, daysOfSupply) {
  if (onHand < -0.005) return 'negative';
  if (onHand <= 0.005) return 'empty';
  if (daysOfSupply !== null && daysOfSupply < INV_LOW_DAYS) return 'low';
  return 'in-stock';
}

// Pit-level stockpile balance as of `cutoff`. The per-product split the
// Inventory tab shows is left out — the executive report reports the piles, not
// the material breakdown.
function computeInventory({ sales, crush, inventory, cutoff, loss }) {
  const inv     = (inventory && typeof inventory === 'object') ? inventory : {};
  const basis   = inv.basis === 'crusher' ? 'crusher' : 'final';
  const openIdx = openingIndex(inv.openings);
  const rateFrom = shiftDays(cutoff, -INV_RATE_WINDOW_DAYS);

  const map = new Map();
  const ensure = key => {
    if (!map.has(key)) {
      const op = openIdx.get(key) || EMPTY_OPENING;
      map.set(key, {
        name: key, opening: op.tons, openingAsOf: op.asOf,
        produced: 0, tonsSold: 0, soldRecent: 0, adjustments: 0,
      });
    }
    return map.get(key);
  };
  // A pit that so far carries only an opening count still has a pile.
  openIdx.forEach((_v, loc) => ensure(loc));

  const inScope = (r, key) =>
    rowInWindow(r.date, (openIdx.get(key) || EMPTY_OPENING).asOf, cutoff);

  // Sellable tons a crushing row adds to the pile, per the configured basis.
  const producedTons = r => {
    const est = crushCalc(r).estimatedTons;
    return basis === 'crusher' ? est : loss.finalFor(est, r.locationName);
  };

  for (const r of crush) {
    if (!r) continue;
    const key = locKey(r.locationName);
    if (!inScope(r, key)) continue;
    ensure(key).produced += producedTons(r);
  }
  for (const r of sales) {
    if (!r) continue;
    const key = locKey(r.locationName);
    if (!inScope(r, key)) continue;
    const e = ensure(key);
    const t = Number(r.tons);
    if (!Number.isFinite(t)) continue;
    e.tonsSold += t;
    if (rateFrom && isoDate(r.date) > rateFrom) e.soldRecent += t;
  }
  for (const r of (Array.isArray(inv.adjustments) ? inv.adjustments : [])) {
    if (!r) continue;
    const key = locKey(r.locationName);
    if (!inScope(r, key)) continue;
    const t = Number(r.tons);
    if (!Number.isFinite(t) || t === 0) continue;
    ensure(key).adjustments += t;
  }

  const locations = [...map.values()].map(e => {
    e.onHand       = e.opening + e.produced - e.tonsSold + e.adjustments;
    e.dailyRate    = e.soldRecent > 0 ? e.soldRecent / INV_RATE_WINDOW_DAYS : 0;
    e.daysOfSupply = (e.dailyRate > 0 && e.onHand > 0) ? e.onHand / e.dailyRate : null;
    e.status       = stockStatus(e.onHand, e.daysOfSupply);
    return e;
  }).sort((a, b) => b.onHand - a.onHand || a.name.localeCompare(b.name));

  const sum = k => locations.reduce((s, e) => s + (Number(e[k]) || 0), 0);
  const tOnHand     = sum('onHand');
  const tSoldRecent = sum('soldRecent');
  const tDailyRate  = tSoldRecent > 0 ? tSoldRecent / INV_RATE_WINDOW_DAYS : 0;
  const total = {
    onHand: tOnHand,
    dailyRate: tDailyRate,
    daysOfSupply: (tDailyRate > 0 && tOnHand > 0) ? tOnHand / tDailyRate : null,
  };
  return { locations, total, basis };
}

// Production vs depletion over the cutoff's own month — is the pile growing?
function monthFlow({ sales, crush, inventory, cutoff, loss, pitNames }) {
  const inv     = (inventory && typeof inventory === 'object') ? inventory : {};
  const basis   = inv.basis === 'crusher' ? 'crusher' : 'final';
  const openIdx = openingIndex(inv.openings);
  const month   = String(cutoff || '').slice(0, 7);
  const names   = new Set(pitNames);
  const out     = { month, produced: 0, sold: 0, adj: 0, net: 0 };

  const inScope = r => {
    if (!r) return false;
    const key = locKey(r.locationName);
    if (!names.has(key)) return false;
    if (isoDate(r.date).slice(0, 7) !== month) return false;
    return rowInWindow(r.date, (openIdx.get(key) || EMPTY_OPENING).asOf, cutoff);
  };

  for (const r of crush) {
    if (!inScope(r)) continue;
    const est = crushCalc(r).estimatedTons;
    out.produced += basis === 'crusher' ? est : loss.finalFor(est, r.locationName);
  }
  for (const r of sales) {
    if (!inScope(r)) continue;
    const t = Number(r.tons);
    if (Number.isFinite(t)) out.sold += t;
  }
  for (const r of (Array.isArray(inv.adjustments) ? inv.adjustments : [])) {
    if (!inScope(r)) continue;
    const t = Number(r.tons);
    if (Number.isFinite(t)) out.adj += t;
  }
  out.net = out.produced - out.sold + out.adj;
  return out;
}

// The one pit worth looking at first: oversold beats low stock beats fine.
// "Oversold" means sales exceed what production plus the opening balance can
// account for — usually a missed crushing entry or an opening never entered.
function stockAlert(locations) {
  if (!locations.length) return { value: '—', sub: 'No locations yet', tone: 'mute' };

  const oversold = locations.filter(e => e.onHand < -0.005).sort((a, b) => a.onHand - b.onHand);
  if (oversold.length) {
    return {
      value: oversold[0].name, tone: 'red',
      sub: `Oversold by ${Math.abs(oversold[0].onHand).toFixed(2)} tons — check for a missing crushing entry or opening balance`,
    };
  }
  const withSupply = locations.filter(e => e.daysOfSupply !== null)
    .sort((a, b) => a.daysOfSupply - b.daysOfSupply);
  const lowest = withSupply[0];
  if (lowest && lowest.daysOfSupply < INV_LOW_DAYS) {
    return {
      value: lowest.name, tone: 'red',
      sub: `${Math.round(lowest.daysOfSupply)} days of stock left at the current sales rate`,
    };
  }
  if (lowest) {
    return {
      value: 'All pits stocked', tone: 'green',
      sub: `Lowest is ${lowest.name} at ${Math.round(lowest.daysOfSupply)} days`,
    };
  }
  return { value: 'All pits stocked', tone: 'green', sub: 'No sales rate to measure against yet' };
}

// ── Performance by location ──────────────────────────────────────────
// Homer City and McGees Mills run different setups, so nothing is blended
// across pits: each stands alone and the division total is rebuilt from the raw
// sums (never an average of averages). Cost metrics follow the page:
//   Avg Cost / Ton Sold = total pit cost (daily + crushing) ÷ tons sold
//   Cost / Ton          = crushing cost ÷ tons crushed  (production cost)
function computeByLocation({ sales, daily, crush, loss }) {
  const map = new Map();
  const ensure = name => {
    const key = locKey(name);
    if (!map.has(key)) map.set(key, {
      name: key,
      totalSales: 0, tonsSold: 0, salesCount: 0,
      dailyCost: 0, dailyHours: 0,
      crushCost: 0, crushHours: 0, tonsCrushed: 0,
    });
    return map.get(key);
  };

  for (const r of sales) {
    if (!r) continue;
    const e = ensure(r.locationName);
    e.totalSales += salesAmount(r);
    const t = Number(r.tons);
    if (Number.isFinite(t)) e.tonsSold += t;
    e.salesCount++;
  }
  for (const r of daily) {
    if (!r) continue;
    const e = ensure(r.locationName);
    e.dailyCost += dailyCalc(r).totalCost;
    e.dailyHours += num(r.hours);
  }
  for (const r of crush) {
    if (!r) continue;
    const e = ensure(r.locationName);
    const c = crushCalc(r);
    e.crushCost   += c.totalCost;
    e.tonsCrushed += c.estimatedTons;
    e.crushHours  += num(r.hoursCrushing);
  }

  const decorate = e => {
    e.totalCost          = e.dailyCost + e.crushCost;
    e.totalHours         = e.dailyHours + e.crushHours;
    e.grossMargin        = e.totalSales - e.totalCost;
    e.marginPct          = e.totalSales > 0 ? (e.grossMargin / e.totalSales) * 100 : 0;
    e.avgPricePerTon     = e.tonsSold > 0 ? e.totalSales / e.tonsSold : 0;
    e.avgCostPerTonSold  = e.tonsSold > 0 ? e.totalCost / e.tonsSold : 0;
    e.costPerTon         = e.tonsCrushed > 0 ? e.crushCost / e.tonsCrushed : 0;
    e.lossPct            = loss.pctFor(e.name);
    e.hasLoss            = loss.hasFor(e.name);
    e.finalScreenTons    = loss.finalFor(e.tonsCrushed, e.name);
    return e;
  };

  const locations = [...map.values()].map(decorate)
    .sort((a, b) => b.totalSales - a.totalSales || b.tonsCrushed - a.tonsCrushed);

  // Division total from the raw sums. The loss % is tonnage-weighted — tons
  // genuinely lost across all pits ÷ all tons crushed — so a big pit can't be
  // hidden behind a small one. hasLoss on the total means every crushing pit
  // has a figure entered, which is the single gate for showing a real loss.
  const total = {
    name: 'Division Total',
    totalSales: 0, tonsSold: 0, salesCount: 0,
    dailyCost: 0, dailyHours: 0, crushCost: 0, crushHours: 0, tonsCrushed: 0,
  };
  let lostTons = 0, crushingPits = 0, crushingPitsWithLoss = 0;
  for (const e of locations) {
    total.totalSales  += e.totalSales;
    total.tonsSold    += e.tonsSold;
    total.salesCount  += e.salesCount;
    total.dailyCost   += e.dailyCost;
    total.dailyHours  += e.dailyHours;
    total.crushCost   += e.crushCost;
    total.crushHours  += e.crushHours;
    total.tonsCrushed += e.tonsCrushed;
    if (e.tonsCrushed > 0) {
      crushingPits++;
      if (e.hasLoss) { crushingPitsWithLoss++; lostTons += e.tonsCrushed - e.finalScreenTons; }
    }
  }
  total.totalCost         = total.dailyCost + total.crushCost;
  total.totalHours        = total.dailyHours + total.crushHours;
  total.grossMargin       = total.totalSales - total.totalCost;
  total.marginPct         = total.totalSales > 0 ? (total.grossMargin / total.totalSales) * 100 : 0;
  total.avgPricePerTon    = total.tonsSold > 0 ? total.totalSales / total.tonsSold : 0;
  total.avgCostPerTonSold = total.tonsSold > 0 ? total.totalCost / total.tonsSold : 0;
  total.costPerTon        = total.tonsCrushed > 0 ? total.crushCost / total.tonsCrushed : 0;
  total.hasLoss           = crushingPits > 0 && crushingPitsWithLoss === crushingPits;
  total.lossPct           = total.tonsCrushed > 0 ? (lostTons / total.tonsCrushed) * 100 : 0;
  total.finalScreenTons   = total.tonsCrushed - lostTons;

  return { locations, total };
}

// ── Break-even ───────────────────────────────────────────────────────
// Variable cost is crushing labour and fuel only (daily tracking excluded),
// spread over tons crushed. Royalty comes off the price, so contribution is
// price − royalty/ton − variable cost/ton.
function computeBreakeven({ sales, crush, royalty, fixed }) {
  const locs = new Map();
  const ensure = name => {
    const key = locKey(name);
    if (!locs.has(key)) locs.set(key, {
      name: key,
      revenue: 0, tonsSold: 0, varCost: 0, tonsCrushed: 0, royaltyCost: 0,
      salesMonths: new Set(), activeMonths: new Set(),
    });
    return locs.get(key);
  };

  for (const r of sales) {
    if (!r) continue;
    const e = ensure(r.locationName);
    e.revenue += salesAmount(r);
    if (royalty.rowBears(r)) e.royaltyCost += royalty.forSale(r.locationName, r.tons, r.pricePerTon);
    const t = Number(r.tons);
    if (Number.isFinite(t)) e.tonsSold += t;
    const mk = monthKey(r.date);
    if (mk) e.activeMonths.add(mk);
    if (mk && Number.isFinite(t) && t > 0) e.salesMonths.add(mk);
  }
  for (const r of crush) {
    if (!r) continue;
    const e = ensure(r.locationName);
    const mk = monthKey(r.date);
    if (mk) e.activeMonths.add(mk);
    const c = crushCalc(r);
    e.varCost     += c.totalCost;
    e.tonsCrushed += c.estimatedTons;
  }
  // Surface pits that have fixed costs entered but no activity yet.
  for (const scope of fixed.pitScopes()) ensure(scope);

  const finalize = e => {
    const tonsBasis     = e.tonsCrushed > 0 ? e.tonsCrushed : e.tonsSold;
    const avgPrice      = e.tonsSold > 0 ? e.revenue / e.tonsSold : null;
    const varCostPerTon = tonsBasis > 0 ? e.varCost / tonsBasis : null;
    const royaltyPerTon = e.tonsSold > 0 ? e.royaltyCost / e.tonsSold : 0;
    const contribution  = (avgPrice != null && varCostPerTon != null)
      ? avgPrice - royaltyPerTon - varCostPerTon
      : null;
    const monthlyFixed = e.activeMonths.size > 0
      ? fixed.avgOverMonths(e.name, e.activeMonths)
      : fixed.avgOverAll(e.name);

    let breakEvenTons = null;
    if (contribution != null && contribution > 0)      breakEvenTons = monthlyFixed / contribution;
    else if (contribution != null && monthlyFixed <= 0) breakEvenTons = 0;

    const months = e.salesMonths.size;
    return {
      ...e, avgPrice, varCostPerTon, royaltyPerTon, contribution, monthlyFixed,
      breakEvenTons, months,
      avgTonsPerMonth: months > 0 ? e.tonsSold / months : 0,
    };
  };

  const rows = [...locs.values()].map(finalize)
    .sort((a, b) => (b.tonsSold - a.tonsSold) || a.name.localeCompare(b.name));

  // Each pit's break-even already covers its own fixed cost, so the sum is the
  // company's break-even — the point where every pit covers itself. Extensive
  // figures sum; per-ton figures stay blended over the year.
  const T = {
    revenue: 0, tonsSold: 0, varCost: 0, tonsCrushed: 0, royaltyCost: 0,
    monthlyFixed: 0, beTons: 0, beTonsAny: false, avgTonsPerMonth: 0,
    salesMonths: new Set(),
  };
  for (const r of rows) {
    T.revenue += r.revenue; T.tonsSold += r.tonsSold;
    T.varCost += r.varCost; T.tonsCrushed += r.tonsCrushed;
    T.royaltyCost += r.royaltyCost;
    T.monthlyFixed += r.monthlyFixed || 0;
    if (r.breakEvenTons != null) { T.beTons += r.breakEvenTons; T.beTonsAny = true; }
    T.avgTonsPerMonth += r.avgTonsPerMonth || 0;
    r.salesMonths.forEach(m => T.salesMonths.add(m));
  }
  const tBasis         = T.tonsCrushed > 0 ? T.tonsCrushed : T.tonsSold;
  const tAvgPrice      = T.tonsSold > 0 ? T.revenue / T.tonsSold : null;
  const tVarCostPerTon = tBasis > 0 ? T.varCost / tBasis : null;
  const tRoyaltyPerTon = T.tonsSold > 0 ? T.royaltyCost / T.tonsSold : 0;
  const total = {
    name: 'All Pits',
    avgPrice: tAvgPrice,
    varCostPerTon: tVarCostPerTon,
    royaltyPerTon: tRoyaltyPerTon,
    contribution: (tAvgPrice != null && tVarCostPerTon != null)
      ? tAvgPrice - tRoyaltyPerTon - tVarCostPerTon
      : null,
    monthlyFixed: T.monthlyFixed,
    breakEvenTons: T.beTonsAny ? T.beTons : null,
    months: T.salesMonths.size,
    avgTonsPerMonth: T.avgTonsPerMonth,
  };
  return { rows, total };
}

// Above or below break-even, in the Break-Even tab's own words.
function breakEvenStatus(d) {
  if (d.contribution == null)   return { tone: 'mute', value: 'Needs data',  sub: 'No sales or crushing to measure' };
  if (d.contribution <= 0)      return { tone: 'red',  value: 'None',        sub: 'cost ≥ price per ton' };
  if (d.monthlyFixed <= 0)      return { tone: 'mute', value: 'Set costs',   sub: 'on the Quarry page' };
  if (d.breakEvenTons == null)  return { tone: 'mute', value: '—',           sub: 'needs sales data' };
  if (d.months === 0)           return { tone: 'mute', value: '—',           sub: 'no sales in range' };
  const diff = d.avgTonsPerMonth - d.breakEvenTons;
  return diff >= 0
    ? { tone: 'green', value: 'Above', sub: `by ${diff.toFixed(2)} t/mo · need ${d.breakEvenTons.toFixed(2)}` }
    : { tone: 'red',   value: 'Below', sub: `by ${Math.abs(diff).toFixed(2)} t/mo · need ${d.breakEvenTons.toFixed(2)}` };
}

// ── The roll-up the executive report asks for ────────────────────────
// `year` scopes the activity figures (the Quarry Home tab's Year filter, which
// defaults to the current year). `cutoff` is the date the stockpile balances
// through — today for the current year, that year's end for a past one.
function quarryMetrics({ sales, daily, crush, inventory, lossPct, monthlyFixed, royalty, lists, year, cutoff }) {
  const allSales = (Array.isArray(sales) ? sales : []).filter(r => r && typeof r === 'object');
  const allDaily = (Array.isArray(daily) ? daily : []).filter(r => r && typeof r === 'object');
  const allCrush = (Array.isArray(crush) ? crush : []).filter(r => r && typeof r === 'object');

  const yr      = String(year);
  const inYear  = r => rowYear(r.date) === yr;
  const ySales  = allSales.filter(inYear);
  const yDaily  = allDaily.filter(inYear);
  const yCrush  = allCrush.filter(inYear);

  const loss     = lossHelpers(lossPct);
  const royaltyH = royaltyHelpers(royalty, lists);
  const fixed    = fixedHelpers(monthlyFixed);

  const byLoc = computeByLocation({ sales: ySales, daily: yDaily, crush: yCrush, loss });

  // The pile is a point in time, so it balances over EVERY row through the
  // cutoff rather than only the selected year's.
  const inv  = computeInventory({ sales: allSales, crush: allCrush, inventory, cutoff, loss });
  const flow = monthFlow({
    sales: allSales, crush: allCrush, inventory, cutoff, loss,
    pitNames: inv.locations.map(e => e.name),
  });
  const alert = stockAlert(inv.locations);
  const be    = computeBreakeven({ sales: ySales, crush: yCrush, royalty: royaltyH, fixed }).total;

  return {
    year: yr,
    cutoff,
    entryCount: ySales.length + yDaily.length + yCrush.length,
    inventory: inv,
    flow,
    alert,
    breakEven: { ...be, status: breakEvenStatus(be) },
    locations: byLoc.locations,
    total: byLoc.total,
  };
}

module.exports = {
  NO_LOCATION,
  normalizeOpenings,
  INV_RATE_WINDOW_DAYS,
  INV_LOW_DAYS,
  salesAmount,
  dailyCalc,
  crushCalc,
  lossHelpers,
  royaltyHelpers,
  fixedHelpers,
  computeInventory,
  monthFlow,
  stockAlert,
  computeByLocation,
  computeBreakeven,
  breakEvenStatus,
  quarryMetrics,
};
