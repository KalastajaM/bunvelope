// js/core/queries/investments-tax.js — one calendar year of realised sales
// for the tax return: the Investments page's tax card.
//
// FIFO acquisition cost beside the deemed acquisition cost, per sale, and the
// year's totals with the €1,000 small-sales rules. Sales in pension insurance
// and tax-wrapped accounts are left out; archived accounts' sales count.
// The year is `year` when a sale falls in it, else the newest year with one.

import { ok } from '../result.js';
import { getInvestmentsMeta } from '../investments-meta.js';
import { taxExemptAccountIds } from '../portfolio.js';
import { computeRealizedSales, summarizeTaxYear } from '../../engine/tax-lots.js';
import { round2 } from '../../utils.js';

const NO_SALES = Object.freeze({
  years: [], year: null, totals: { grossProceeds: 0, purchaseCost: 0, deductedCost: 0, gains: 0, losses: 0, net: 0 },
  gainsExempt: false, lossesDeductible: false, salesWithoutCost: 0, sales: [],
});

export default {
  name: 'investments.tax',
  summary: 'Realised sales of a calendar year for the tax return (not pension insurance, tax-wrapped accounts or holdings explicitly marked valuationOnly): years (every year with a sale, newest first), year (the one asked for when it has sales, else the newest), totals (grossProceeds, purchaseCost, deductedCost (acquisition costs incl. sale expenses, or the deemed cost; grossProceeds − deductedCost = net), gains, losses, net), gainsExempt (proceeds ≤ 1000), lossesDeductible (purchase cost > 1000), salesWithoutCost (sales of units with no cost on record) and per sale its proceeds, FIFO acquisition cost, fee, cost (acquisition cost plus fee), actual and deemed gain, and the taxable gain with its method. Without sales, years is empty and year null.',
  input: {
    type: 'object',
    properties: {
      year: { type: 'integer', minimum: 1, maximum: 9999, description: 'The calendar year (default the newest with a sale; a year without one reads the newest)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ year?: number }} input
   */
  run(data, input) {
    const inv = getInvestmentsMeta(data.meta);
    const sales = computeRealizedSales(data.transactions || [], {
      manualRows: inv.manualRows,
      excludeAccountIds: taxExemptAccountIds(data.accounts),
    }).filter(sale => inv.holdingOverrides?.[sale.accountId]?.[sale.symbol]?.valuationOnly !== true);
    if (!sales.length) return ok(structuredClone(NO_SALES));
    const newest = Number(sales[sales.length - 1].date.slice(0, 4));
    const years = summarizeTaxYear(sales, newest).years;
    const year = input.year !== undefined && years.includes(input.year) ? input.year : newest;
    const s = summarizeTaxYear(sales, year);
    return ok({
      years,
      year,
      totals: { grossProceeds: s.grossProceeds, purchaseCost: s.purchaseCost, deductedCost: s.deductedCost, gains: s.gains, losses: s.losses, net: s.net },
      gainsExempt: s.gainsExempt,
      lossesDeductible: s.lossesDeductible,
      salesWithoutCost: s.salesWithoutCost,
      sales: s.sales.map(x => ({
        id: x.id ?? null,
        date: x.date,
        symbol: x.symbol,
        accountId: x.accountId,
        units: x.units,
        grossProceeds: x.grossProceeds,
        acquisitionCost: x.acquisitionCost,
        fee: x.fee,
        cost: round2(x.acquisitionCost + x.fee),
        actualGain: x.actualGain,
        deemedGain: x.deemedGain,
        taxableGain: x.taxableGain,
        method: x.method,
      })),
    });
  },
};
