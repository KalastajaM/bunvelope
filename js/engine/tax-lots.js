// js/engine/tax-lots.js — realised gains the way the Finnish tax return
// computes them: first in, first out, with the deemed acquisition cost.
//
// The Holdings view values positions at average cost (holdings.js), which is
// the right picture of a position but not the figure Vero taxes. For shares
// or fund units of one kind bought at different times, the units sold are the
// oldest ones, per securities account (vero.fi, "Selling shares"). For each
// sale the seller may instead deduct a deemed acquisition cost: 20 % of the
// selling price, 40 % for units held ten years or more, in place of the
// purchase price AND the expenses. This module walks the same trades as
// `computeHoldings`, keeps lots, and reports every sale with both figures and
// the smaller gain.
//
// Rules applied, all from vero.fi:
//   - FIFO per (account, symbol); a sale consumes the oldest lots first.
//   - Acquisition cost includes the purchase fee (the buy row's `amount`
//     already does); the sale fee is an expense deducted from the proceeds.
//   - Deemed cost is per sale, cannot be combined with the actual cost or
//     the sale fee, and is a share of the gross selling price.
//   - A calendar year whose selling prices total at most €1,000 is
//     tax-exempt; if the purchase prices of what was sold total at most
//     €1,000, losses are not deductible either (`summarizeTaxYear`). Vero
//     sums ALL movable property sold that year, which the app cannot see, so
//     the page states that.
//
// Not covered: dividends (taxed separately), tax-wrapped accounts (equity
// savings accounts, pension insurance: the caller excludes them), currency
// gains on foreign-currency trades, and corporate actions beyond the
// unit/cost `adjust` row.
//
// Pure functions. No DOM, no I/O.

import { round2, validateAmount } from '../utils.js';
import { txAbsAmount, txDirection } from './tx-amounts.js';
import { txSymbol, manualRowsAsTransactions } from './holdings.js';

const DEEMED_SHORT = 0.2;
const DEEMED_LONG = 0.4;
const LONG_HOLD_YEARS = 10;
const SMALL_SALES_LIMIT = 1000;
const UNIT_EPSILON = 1e-9;

/**
 * @typedef {{ acquired: string, units: number, cost: number }} TaxLot
 *   `acquired` is '' for units with no purchase on record.
 * @typedef {{
 *   id: string, accountId: string, symbol: string, date: string, units: number,
 *   grossProceeds: number, fee: number, acquisitionCost: number,
 *   actualGain: number | null, deemedCost: number, deemedGain: number,
 *   taxableGain: number, method: 'actual' | 'deemed', uncostedUnits: number,
 *   lots: TaxLot[],
 * }} RealizedSale
 */

/**
 * Whether units bought on `acquired` and sold on `sold` were held at least
 * ten years. Both 'YYYY-MM-DD'; an unknown purchase date never qualifies.
 * @param {string} acquired
 * @param {string} sold
 * @returns {boolean}
 */
function heldTenYears(acquired, sold) {
  if (!acquired) return false;
  const y = Number(acquired.slice(0, 4)) + LONG_HOLD_YEARS;
  return `${y}${acquired.slice(4, 10)}` <= sold;
}

/** @param {any} tx */
function dayOf(tx) {
  return typeof tx?.date === 'string' ? tx.date.slice(0, 10) : '';
}

/**
 * Every sale in `transactions` (plus manual correction rows), with its FIFO
 * acquisition cost, its deemed cost, and the gain to declare. Sorted by date.
 *
 * A sale of more units than the lots on record hold (a position moved in
 * from another broker whose purchase was never entered) has no actual cost
 * for the excess: `actualGain` is null and only the deemed cost applies,
 * which is exactly what the deemed cost exists for.
 *
 * @param {any[]} transactions
 * @param {{ manualRows?: Record<string, Record<string, any[]>>, excludeAccountIds?: Set<string> }} [opts]
 * @returns {RealizedSale[]}
 */
export function computeRealizedSales(transactions, opts = {}) {
  const exclude = opts.excludeAccountIds || new Set();
  const synth = manualRowsAsTransactions(opts.manualRows);
  const rows = synth.length ? [...(transactions || []), ...synth] : (transactions || []);

  // Same order as computeHoldings: by date, a day's sells after its buys.
  const sellRank = (/** @type {any} */ tx) => (tx?.type === 'investment_transfer' && txDirection(tx) === 'sell' ? 1 : 0);
  const ordered = rows.slice().sort((a, b) => {
    const da = dayOf(a);
    const db = dayOf(b);
    if (da !== db) return da < db ? -1 : 1;
    return sellRank(a) - sellRank(b);
  });

  /** @type {Map<string, TaxLot[]>} */
  const lotsByKey = new Map();
  /** @type {RealizedSale[]} */
  const sales = [];

  for (const tx of ordered) {
    if (!tx || tx.type !== 'investment_transfer') continue;
    const sym = txSymbol(tx);
    if (!sym) continue;
    const direction = txDirection(tx);
    const accountId = direction === 'buy' ? tx.to_account : tx.from_account;
    if (!accountId || exclude.has(accountId)) continue;
    const key = `${accountId}\u0000${sym}`;
    let lots = lotsByKey.get(key);
    if (!lots) { lots = []; lotsByKey.set(key, lots); }
    const day = dayOf(tx);

    if (direction === 'adjust') {
      const unitsDelta = validateAmount(tx.units) ?? 0;
      const costDelta = validateAmount(tx.amount) ?? 0;
      applyAdjust(lots, unitsDelta, costDelta, day);
      continue;
    }

    const units = Math.abs(validateAmount(tx.units) ?? 0);
    if (units <= 0) continue; // a buy without units cannot be lotted; a sell without units is skipped, as in holdings
    const cash = txAbsAmount(tx);

    if (direction === 'buy') {
      lots.push({ acquired: day, units, cost: cash });
      continue;
    }
    if (direction !== 'sell') continue;

    const fee = Math.max(0, validateAmount(tx.fee) ?? 0);
    const gross = cash + fee;
    /** @type {TaxLot[]} */
    const used = [];
    let left = units;
    while (left > UNIT_EPSILON && lots.length) {
      const lot = lots[0];
      const take = Math.min(left, lot.units);
      const cost = lot.units > 0 ? lot.cost * (take / lot.units) : 0;
      used.push({ acquired: lot.acquired, units: take, cost });
      lot.units -= take;
      lot.cost -= cost;
      left -= take;
      if (lot.units <= UNIT_EPSILON) lots.shift();
    }
    const uncosted = left > UNIT_EPSILON ? left : 0;

    let acquisitionCost = 0;
    let deemedCost = 0;
    for (const u of used) {
      acquisitionCost += u.cost;
      deemedCost += gross * (u.units / units) * (heldTenYears(u.acquired, day) ? DEEMED_LONG : DEEMED_SHORT);
    }
    deemedCost += gross * (uncosted / units) * DEEMED_SHORT;

    const deemedGain = gross - deemedCost;
    const actualGain = uncosted > 0 ? null : cash - acquisitionCost;
    const useDeemed = actualGain === null || deemedGain < actualGain;

    sales.push({
      id: tx.id,
      accountId,
      symbol: sym,
      date: day,
      units: Math.round(units * 1e6) / 1e6,
      grossProceeds: round2(gross),
      fee: round2(fee),
      acquisitionCost: round2(acquisitionCost),
      actualGain: actualGain === null ? null : round2(actualGain),
      deemedCost: round2(deemedCost),
      deemedGain: round2(deemedGain),
      taxableGain: round2(useDeemed ? deemedGain : /** @type {number} */ (actualGain)),
      method: useDeemed ? 'deemed' : 'actual',
      uncostedUnits: Math.round(uncosted * 1e6) / 1e6,
      lots: used.map(u => ({ acquired: u.acquired, units: Math.round(u.units * 1e6) / 1e6, cost: round2(u.cost) })),
    });
  }
  return sales;
}

/**
 * An `adjust` row on the lots: added units arrive as a new lot only when they
 * bring cost; units added at no cost (a split, a bonus issue) are spread over
 * the open lots pro rata, keeping their purchase dates; removed units leave
 * the oldest lots first, taking their cost; a cost-only change is spread over
 * the open lots by units.
 *
 * @param {TaxLot[]} lots
 * @param {number} unitsDelta
 * @param {number} costDelta
 * @param {string} day
 */
function applyAdjust(lots, unitsDelta, costDelta, day) {
  const open = lots.reduce((n, l) => n + l.units, 0);
  if (unitsDelta > 0 && costDelta === 0 && open > 0) {
    for (const l of lots) l.units += unitsDelta * (l.units / open);
    return;
  }
  if (unitsDelta > 0) {
    lots.push({ acquired: day, units: unitsDelta, cost: costDelta });
    return;
  }
  if (unitsDelta < 0) {
    let left = -unitsDelta;
    while (left > UNIT_EPSILON && lots.length) {
      const lot = lots[0];
      const take = Math.min(left, lot.units);
      lot.cost -= lot.units > 0 ? lot.cost * (take / lot.units) : 0;
      lot.units -= take;
      left -= take;
      if (lot.units <= UNIT_EPSILON) lots.shift();
    }
  }
  if (costDelta !== 0 && unitsDelta <= 0) {
    const remaining = lots.reduce((n, l) => n + l.units, 0);
    if (remaining > 0) for (const l of lots) l.cost += costDelta * (l.units / remaining);
  }
}

/**
 * One calendar year of `computeRealizedSales`: its sales, totals, and the
 * €1,000 small-sales rules. `years` lists every year with a sale, newest
 * first, for a picker. `purchaseCost` is the FIFO acquisition cost of what
 * was sold (the small-sales rule reads it); `deductedCost` is what the return
 * deducts (acquisition cost and expenses, or the deemed cost), so
 * `grossProceeds − deductedCost === net`.
 *
 * @param {RealizedSale[]} sales
 * @param {number} year
 */
export function summarizeTaxYear(sales, year) {
  const prefix = `${year}-`;
  const inYear = (sales || []).filter(s => s.date.startsWith(prefix));
  let grossProceeds = 0;
  let purchaseCost = 0;
  let deductedCost = 0;
  let gains = 0;
  let losses = 0;
  let uncosted = 0;
  for (const s of inYear) {
    grossProceeds += s.grossProceeds;
    purchaseCost += s.acquisitionCost;
    // What the return deducts from the proceeds: acquisition cost plus the
    // sale's expenses under the actual method, the deemed cost otherwise.
    // Proceeds minus this foots to the net.
    deductedCost += s.grossProceeds - s.taxableGain;
    if (s.taxableGain >= 0) gains += s.taxableGain;
    else losses += s.taxableGain;
    if (s.uncostedUnits > 0) uncosted++;
  }
  const years = [...new Set((sales || []).map(s => Number(s.date.slice(0, 4))).filter(Number.isFinite))]
    .sort((a, b) => b - a);
  return {
    year,
    years,
    sales: inYear,
    grossProceeds: round2(grossProceeds),
    purchaseCost: round2(purchaseCost),
    deductedCost: round2(deductedCost),
    gains: round2(gains),
    losses: round2(losses),
    net: round2(gains + losses),
    // vero.fi: selling prices ≤ €1,000 in the year → the gains are tax-free;
    // purchase prices of what was sold ≤ €1,000 → losses are not deductible.
    gainsExempt: grossProceeds <= SMALL_SALES_LIMIT,
    lossesDeductible: purchaseCost > SMALL_SALES_LIMIT,
    salesWithoutCost: uncosted,
  };
}
