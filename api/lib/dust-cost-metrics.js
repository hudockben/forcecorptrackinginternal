'use strict';
/* Dust product cost and margin — a PORT of dust.html's renderProfitMargin().
 *
 * Until now dust was the division Mathis had to refuse: revenue was available
 * server-side, margin was not, because the whole calculation lived in the
 * browser and nothing outside that page could reach it. "What is our margin on
 * a gallon of UB" is the second question anyone asks about dust, so the
 * refusal was correct and unsatisfying in equal measure.
 *
 * This is that arithmetic, moved rather than reinvented. The order of
 * operations matters more than it looks:
 *
 *   Per-gallon figures are rounded to the cent BEFORE profit is taken, because
 *   that is the unit the business prices and communicates in. dust.html has a
 *   comment saying exactly this, and the reason is that a margin computed from
 *   unrounded per-gallon costs drifts from what anyone gets by hand — cents on
 *   a gallon, hundreds of dollars on a season.
 *
 *   Cost to make is the CONCENTRATE cost divided by the mix ratio. The batch
 *   makes concentrate; the truck sprays it diluted. Comparing an undiluted
 *   cost against a diluted charge would report a loss on a profitable product.
 *
 *   Nothing is a figure until it is ready. With no batch entered, or no charge
 *   to compare against, margin is null and not zero — the page shows a dash
 *   there, and a zero would be a claim the division breaks even exactly.
 *
 * scripts/test-dust-cost-port.js drives the real page in jsdom over the same
 * fixture and asserts the two agree. A port that drifts is worse than no port,
 * because the page and the assistant would both sound certain.
 */

const { rowTotals, ubRateResolver } = require('./dust-metrics');

const num    = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
const round2 = n => Math.round(n * 100) / 100;

/**
 * @param pm         the `profit_margin` object out of the dust settings blob
 * @param rows       dust_control_entries rows (the Tracking book)
 * @param ubRate     division default $/gal
 * @param companies  per-customer UB rate overrides
 * @param year       optional 'YYYY' — the panel's own year filter
 */
function dustProductMargin({ pm, rows, ubRate, companies, year }) {
  const p = (pm && typeof pm === 'object') ? pm : {};

  // ── Batch cost ──
  const baseGal = num(p.base_gal),  baseRate = num(p.base_rate);
  const soapGal = num(p.soap_gal),  soapRate = num(p.soap_rate);
  const watGal  = num(p.water_gal), watRate  = num(p.water_rate);
  const baseCost  = baseGal * baseRate;
  const soapCost  = soapGal * soapRate;
  const waterCost = watGal  * watRate;
  const totalCost = round2(baseCost + soapCost + waterCost);
  const totalGallons = baseGal + soapGal + watGal;

  // ── Dilution ──
  const concentratePerGal = totalGallons > 0 ? round2(totalCost / totalGallons) : 0;
  const mixParts = num(p.mix_parts);
  const costToMake = (totalGallons > 0 && mixParts > 0)
    ? round2((totalCost / totalGallons) / mixParts)
    : 0;

  // ── What customers are actually charged, from Tracking ──
  const rateFor = ubRateResolver(companies || [], ubRate || 0);
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => !year || String((r && r.date) || '').startsWith(String(year)));

  let invoiced = 0, ubRevenue = 0, gallons = 0, jobs = 0;
  for (const r of list) {
    const c = rowTotals(r, rateFor);
    invoiced  += c.invTotal;
    ubRevenue += c.ubTotal;
    gallons   += c.gallons;
    jobs++;
  }
  const perGalInvoice = gallons > 0 ? invoiced  / gallons : 0;
  const perGalUb      = gallons > 0 ? ubRevenue / gallons : 0;

  // ── The charge, per the basis the division picked ──
  const basis = p.charge_basis === 'custom' ? 'custom'
              : p.charge_basis === 'ub'     ? 'ub'
              : 'invoice';
  const chargePerGal = basis === 'custom' ? round2(num(p.charge))
                     : basis === 'ub'     ? round2(perGalUb)
                     :                      round2(perGalInvoice);

  // ── Profit, margin, markup ──
  const ready  = costToMake > 0 && chargePerGal > 0;
  const profit = round2(chargePerGal - costToMake);

  return {
    ready,
    batch: {
      baseCost:  round2(baseCost),
      soapCost:  round2(soapCost),
      waterCost: round2(waterCost),
      totalCost,
      totalGallons,
    },
    concentratePerGal,
    mixParts,
    costToMakePerGal: costToMake,
    chargeBasis: basis,
    chargePerGal,
    tracking: {
      jobs,
      gallons: round2(gallons),
      invoiced:  round2(invoiced),
      ubRevenue: round2(ubRevenue),
      perGalInvoice: round2(perGalInvoice),
      perGalUb:      round2(perGalUb),
      year: year ? String(year) : null,
    },
    // Null, not zero, whenever there is not enough entered to have an answer.
    profitPerGal: ready ? profit : null,
    marginPct:    ready ? round2((profit / chargePerGal) * 100) : null,
    markupPct:    ready ? round2((profit / costToMake)   * 100) : null,
  };
}

module.exports = { dustProductMargin };
