// js/engine/holdings.js — investment-holding aggregation.
//
// Aggregates `investment_transfer` rows into per-(account, symbol) positions
// using average-cost-basis. Buys add units and cash cost; sells remove
// units at the current average cost (the difference vs the cash received
// feeds `realized`). Broker fees are folded into cost basis on buys and
// reduce realized P/L on sells, matching the engine's account delta math.
//
// Pure functions. No DOM, no I/O.

import { round2, validateAmount } from '../utils.js';
import { memoizeHoldings as _memoizeHoldings } from './balance-cache.js';
import { txAbsAmount, txDirection } from './tx-amounts.js';

/**
 * Normalised symbol for an investment_transfer: trimmed, uppercased, or
 * `null` when missing. Used as the holding-bucket key.
 */
export function txSymbol(tx) {
  if (!tx || typeof tx.symbol !== 'string') return null;
  const s = tx.symbol.trim().toUpperCase();
  return s || null;
}

/**
 * Aggregate `investment_transfer` rows into per-(account, symbol) holdings
 * using the average-cost-basis method. Buys add units and cash cost; sells
 * remove units at the current average cost (the difference vs the cash
 * received feeds `realized`). Broker fees are folded into cost basis on
 * buys and reduce realized P/L on sells, matching the engine's account
 * delta math.
 *
 * Rows without a symbol or without positive units are skipped — they remain
 * visible only via the underlying account balance, not as a discrete
 * holding line.
 *
 * Returns `Map<accountId, Map<symbol, {units, costBasis, realized,
 * distributions, oversoldUnits}>>`. Numbers are rounded to 6/2 decimals.
 *
 * `oversoldUnits` is how many units were sold beyond what this ledger knows
 * the position ever held — non-zero means the realized figure covers only
 * part of what was sold, and is a data problem to fix rather than a number to
 * trust. Consumers should surface it, not silently add it in.
 */
export function computeHoldings(transactions) {
  const byAccount = new Map();

  // Date order, then — within one date — every sell after the day's other
  // rows. Array order is entry order, not trade order: a sell typed in before
  // the same day's buy used to run against an empty position, remove
  // nothing, book no realized P/L, and leave the buy's units open for good.
  // A same-day sell can only be selling units that exist by the end of that
  // day, so it goes last. `sort` is stable, so rows of equal rank keep their
  // array order.
  const sellRank = tx => (tx?.type === 'investment_transfer' && txDirection(tx) === 'sell' ? 1 : 0);
  const ordered = (transactions || []).slice().sort((a, b) => {
    const da = (a?.date || '').slice(0, 10);
    const db = (b?.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return sellRank(a) - sellRank(b);
  });

  for (const tx of ordered) {
    if (!tx || tx.type !== 'investment_transfer') continue;
    const sym = txSymbol(tx);
    if (!sym) continue;
    const direction = txDirection(tx);

    // Adjust rows carry signed unit/cost deltas with no cash leg, so
    // they bypass the abs-magnitude processing below.
    if (direction === 'adjust') {
      const acctId = tx.from_account;
      if (!acctId) continue;
      const unitsDelta = validateAmount(tx.units) ?? 0;
      const costDelta = validateAmount(tx.amount) ?? 0;
      if (unitsDelta === 0 && costDelta === 0) continue;
      let perAcct = byAccount.get(acctId);
      if (!perAcct) { perAcct = new Map(); byAccount.set(acctId, perAcct); }
      let h = perAcct.get(sym);
      if (!h) { h = { units: 0, costBasis: 0, realized: 0, distributions: 0, oversoldUnits: 0 }; perAcct.set(sym, h); }
      h.units += unitsDelta;
      h.costBasis += costDelta;
      // Don't snap to zero here — the rounding pass at the bottom of
      // computeHoldings handles tiny residuals via round2/units rounding.
      continue;
    }

    const u = validateAmount(tx.units);
    const units = u === null ? 0 : Math.abs(u);

    const cash = txAbsAmount(tx);
    // Fees are folded into `cash` per the add-tx sign convention
    // (buy: amount = units*price + fee; sell: amount = units*price − fee),
    // so they don't need to be applied again here.
    // Sells must specify units — otherwise we can't reduce the position
    // correctly. Buys without units still count toward cost basis so plain
    // "I bought €100 of X" entries show up as invested capital. Dividends
    // are cash-only (no units) and require a non-zero amount.
    if (direction === 'sell' && units <= 0) continue;
    if (direction === 'buy' && units <= 0 && cash <= 0) continue;
    if (direction === 'dividend' && cash <= 0) continue;
    // The investment account is the buy destination / sell source /
    // dividend source.
    const acctId = direction === 'buy' ? tx.to_account : tx.from_account;
    if (!acctId) continue;

    let perAcct = byAccount.get(acctId);
    if (!perAcct) { perAcct = new Map(); byAccount.set(acctId, perAcct); }
    let h = perAcct.get(sym);
    if (!h) { h = { units: 0, costBasis: 0, realized: 0, distributions: 0, oversoldUnits: 0 }; perAcct.set(sym, h); }

    if (direction === 'buy') {
      // cost = cash paid (already includes fee on the cash side via add-tx's
      // sign convention: amount = units*price + fee). Use cash directly.
      h.units += units;
      h.costBasis += cash;
    } else if (direction === 'sell') {
      // Sell: remove units at average cost; realized = proceeds − avgCost*units.
      //
      // A sell can exceed the units on record — most often a position
      // transferred in from another broker whose original buy was never
      // entered, so part of what is being sold has no cost basis here at all.
      // `removed` has always clamped the unit count, but the FULL cash
      // proceeds used to be booked against that partial cost, which reports
      // every unaccounted unit as pure profit and silently inflates realized
      // P/L. Book only the proceeds attributable to units we can actually
      // cost, and record the shortfall so it reads as missing data rather
      // than as a gain.
      const avg = h.units > 0 ? h.costBasis / h.units : 0;
      const removed = Math.min(units, h.units);
      const costRemoved = avg * removed;
      const proceeds = units > 0 ? cash * (removed / units) : 0;
      h.realized += proceeds - costRemoved;
      h.units -= removed;
      h.costBasis -= costRemoved;
      if (units - removed > 1e-9) h.oversoldUnits += units - removed;
      if (h.units <= 1e-9) { h.units = 0; h.costBasis = 0; }
    } else {
      // Dividend: pure cash income tied to the holding. Doesn't change
      // units or cost basis; tracked separately so reports can answer
      // "how much income has this position thrown off?".
      h.distributions += cash;
    }
  }

  // Round outputs. The buy/sell branches above already snap units to 0
  // when a position closes; adjust rows skip that snap, but the 6dp
  // rounding here catches any sub-microunit float drift (`3e-7` → 0)
  // and `round2` collapses sub-cent costBasis fragments. So a row
  // that's "really" zero — including after a sequence of adjusts —
  // ends up at exactly 0 / 0 here without an extra snap pass.
  for (const perAcct of byAccount.values()) {
    for (const h of perAcct.values()) {
      h.units = Math.round(h.units * 1e6) / 1e6;
      h.costBasis = round2(h.costBasis);
      h.realized = round2(h.realized);
      h.distributions = round2(h.distributions);
      h.oversoldUnits = Math.round((h.oversoldUnits || 0) * 1e6) / 1e6;
    }
  }
  return byAccount;
}

/**
 * Flat helper that merges a `holdingOverrides` map (from meta) into the
 * computed holdings. The override shape is `{ [accountId]: { [symbol]:
 * { units, costBasis, name? } } }`.
 *
 * When real transactions exist for a (account, symbol) pair, the computed
 * units/costBasis win — overrides only seed watchlist-style entries that
 * have no transaction history (see the second loop). The override's
 * optional `name` is still surfaced as a display label either way.
 *
 * Returns an array of `{ accountId, symbol, units, costBasis, realized,
 * name?, overridden }` rows, sorted by accountId then symbol.
 */
// Sentinel account id used when synthesising a cash-symmetric tx for a
// manual buy/sell row in `listHoldings`. Namespaced so it can never
// collide with a real account id (account ids are user-generated short
// slugs in practice). The synth tx never feeds account-balance code —
// it only flows through `computeHoldings` for unit/cost aggregation —
// so the sentinel never appears outside this file.
const MANUAL_EXT_ACCT = '__bunvelope_manual_ext__';

/**
 * Manual correction rows (`meta.investments.manualRows`, see
 * js/state/investments.js) as tx-shaped `investment_transfer` objects, so
 * every walk over trades (holdings here, tax lots in tax-lots.js) handles
 * them identically. They never feed account-balance code.
 *
 * @param {Record<string, Record<string, any[]>> | null | undefined} manualRowsByAcctSym
 * @returns {any[]}
 */
export function manualRowsAsTransactions(manualRowsByAcctSym) {
  // Synthesise tx-shaped objects from manual rows so the existing
  // computeHoldings aggregation handles them identically. They route to
  // the same (account, symbol) bucket via from_account/to_account.
  const synth = [];
  for (const [accountId, bySym] of Object.entries(manualRowsByAcctSym || {})) {
    for (const [symbol, rows] of Object.entries(bySym || {})) {
      for (const r of rows || []) {
        // Deliberately not `txDirection`: a MANUAL row's direction is a
        // closed set of three (buy / sell / adjust, see
        // js/state/investments.js) with no dividend among them.
        const direction = r?.direction === 'sell' ? 'sell'
                        : r?.direction === 'adjust' ? 'adjust'
                        : 'buy';
        // Adjust rows carry signed deltas with no cash leg; they bucket
        // by the investment account directly. Buy/sell synths route the
        // cash side through a sentinel so computeHoldings still treats
        // them as cash-symmetric transfers.
        const accounts = direction === 'adjust'
          ? { from_account: accountId }
          : direction === 'sell'
            ? { from_account: accountId, to_account: MANUAL_EXT_ACCT }
            : { from_account: MANUAL_EXT_ACCT, to_account: accountId };
        synth.push({
          id: r?.id,
          type: 'investment_transfer',
          _manual: true,
          date: r?.date,
          direction,
          units: r?.units,
          amount: r?.amount,
          symbol,
          ...accounts,
        });
      }
    }
  }
  return synth;
}

function _listHoldingsRaw(transactions, holdingOverrides = {}, manualRowsByAcctSym = {}) {
  const synth = manualRowsAsTransactions(manualRowsByAcctSym);
  const computed = computeHoldings(synth.length ? [...(transactions || []), ...synth] : transactions);
  const out = [];
  const seen = new Set();

  for (const [accountId, perAcct] of computed) {
    for (const [symbol, h] of perAcct) {
      const ov = holdingOverrides?.[accountId]?.[symbol];
      /** @type {Holding} */
      const row = {
        accountId, symbol,
        units: h.units, costBasis: h.costBasis,
        realized: h.realized, distributions: h.distributions || 0,
        oversoldUnits: h.oversoldUnits || 0,
        overridden: false,
        ...(ov?.valuationOnly === true ? { valuationOnly: true } : {}),
      };
      if (ov?.name) row.name = ov.name;
      out.push(row);
      seen.add(`${accountId} ${symbol}`);
    }
  }

  // Add overrides that have no transaction history at all.
  for (const [accountId, perAcct] of Object.entries(holdingOverrides || {})) {
    for (const [symbol, ov] of Object.entries(perAcct || {})) {
      if (seen.has(`${accountId} ${symbol}`)) continue;
      const units = Number.isFinite(Number(ov?.units)) ? Number(ov.units) : 0;
      const costBasis = Number.isFinite(Number(ov?.costBasis)) ? Number(ov.costBasis) : 0;
      /** @type {Holding} */
      const row = { accountId, symbol, units, costBasis, realized: 0, distributions: 0, overridden: true, ...(ov?.valuationOnly === true ? { valuationOnly: true } : {}) };
      if (ov?.name) row.name = ov.name;
      out.push(row);
    }
  }

  out.sort((a, b) =>
    a.accountId === b.accountId
      ? a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
      : a.accountId < b.accountId ? -1 : 1);
  return out;
}

export const listHoldings = _memoizeHoldings(_listHoldingsRaw);

// ─── Market value ─────────────────────────────────────────────────────────
//
// A holding's worth needs a price, and prices live in meta (user-entered or
// fetched), not in the ledger. The rule every surface agreed on informally —
// "units × price, falling back to cost basis when no price is known" — was
// written out seven times across the dashboard, the accounts page and the
// investments page, which is how the two unrealized-P/L percentages drifted
// apart (one divided by total cost, the other by priced cost only). It is
// one rule now, and it lives here beside the aggregation it consumes.
//
// `prices` is meta's `{ SYMBOL: { price } }` map. Values are deliberately
// left unrounded: these feed `moneyEl`, which rounds at the edge.

/**
 * One aggregated position, as `listHoldings` returns it.
 *
 * @typedef {{
 *   accountId: string, symbol: string, units: number, costBasis: number,
 *   realized?: number, distributions?: number, oversoldUnits?: number,
 *   overridden?: boolean, name?: string, valuationOnly?: boolean,
 * }} Holding
 */

/**
 * Meta's price map: `{ SYMBOL: { price } }`.
 * @typedef {Record<string, { price?: number | null } | undefined>} PriceMap
 */

/**
 * The known market price for a holding, or `null` when there is none.
 * A non-finite stored price counts as absent rather than as zero.
 *
 * @param {Holding | null | undefined} holding
 * @param {PriceMap | null | undefined} prices
 * @returns {number | null}
 */
export function holdingPrice(holding, prices) {
  // Guard the holding before indexing, not inside the index: optional
  // chaining on `holding?.symbol` short-circuits that read alone, so
  // `prices?.[holding?.symbol]` still performs a lookup — of the key
  // "undefined" — when there is no holding at all.
  const symbol = holding?.symbol;
  if (!symbol) return null;
  const p = prices?.[symbol]?.price;
  return Number.isFinite(p) && typeof p === 'number' ? p : null;
}

/**
 * Whether a holding can be marked to market: it has a price AND units to
 * multiply it by. A buy entered without units ("I put €100 into X") is a
 * legitimate row that aggregates to cost basis with zero units; pricing it
 * as `0 × price` valued it at nothing and showed a −100% loss. Such a
 * position is treated exactly like an unpriced one — held at cost.
 *
 * @param {Holding | null | undefined} holding
 * @param {PriceMap | null | undefined} prices
 * @returns {number | null} the price to value it at, or null for "use cost"
 */
export function holdingMarkPrice(holding, prices) {
  const price = holdingPrice(holding, prices);
  if (price === null) return null;
  const units = holding?.units;
  return typeof units === 'number' && Number.isFinite(units) && units !== 0 ? price : null;
}

/**
 * Market value of one holding: `units × price`, or the cost basis when no
 * price is known or there are no units to price. The fallback keeps an
 * untracked position visible at what was paid for it instead of collapsing it
 * to zero — so a portfolio total never silently loses a holding, it just
 * stops moving with the market. Value-only holdings have no cost fallback;
 * without a usable price they contribute zero and remain flagged as unpriced.
 *
 * @param {Holding | null | undefined} holding
 * @param {PriceMap | null | undefined} prices
 * @returns {number}
 */
export function holdingValue(holding, prices) {
  if (!holding) return 0;
  const price = holdingMarkPrice(holding, prices);
  if (price === null) return holding.valuationOnly ? 0 : holding.costBasis ?? 0;
  return holding.units * price;
}

/**
 * Portfolio totals over a list of holdings.
 *
 *   Value-only holdings contribute to value and price counts, but not cost or gains.
 *
 *   cost        — cost basis of holdings that track cost
 *   costPriced  — cost basis of the holdings that have a price
 *   value       — market value with the cost-basis fallback (the figure a
 *                 "portfolio worth" line should show)
 *   valuePriced — market value of the priced holdings alone
 *   unrealized  — gain on priced holdings that track cost.
 *   unrealizedPct — against `costPriced`, the cost the gain was actually
 *                 earned on. Dividing by total `cost` (as the dashboard once
 *                 did) dilutes the percentage by holdings that were never
 *                 valued.
 *   priced / missingPrice — counts of open positions (units > 0) with and
 *                 without a price, for "n holdings need a price" hints.
 *
 * @param {readonly Holding[] | null | undefined} holdings
 * @param {PriceMap | null | undefined} prices
 */
export function summarizeHoldings(holdings, prices) {
  let cost = 0, costPriced = 0, valuePriced = 0, gainValue = 0, value = 0, priced = 0, missingPrice = 0;
  for (const h of holdings || []) {
    const basis = h?.costBasis ?? 0;
    const tracksCost = h?.valuationOnly !== true;
    if (tracksCost) cost += basis;
    value += holdingValue(h, prices);
    // `holdingMarkPrice`, not `holdingPrice`: a unit-less position with a price
    // cannot be valued either, so it stays on the cost side with the
    // unpriced ones rather than contributing a −100% "loss".
    const price = holdingMarkPrice(h, prices);
    if (price === null) {
      if ((h?.units ?? 0) > 0) missingPrice++;
    } else {
      if (tracksCost) {
        costPriced += basis;
        gainValue += h.units * price;
      }
      valuePriced += h.units * price;
      if (h.units > 0) priced++;
    }
  }
  const unrealized = gainValue - costPriced;
  return {
    cost,
    costPriced,
    value,
    valuePriced,
    unrealized,
    unrealizedPct: costPriced > 0 ? (unrealized / costPriced) * 100 : 0,
    priced,
    missingPrice,
  };
}

/**
 * Market value summed per account, as `Map<accountId, value>`. Accounts in
 * `seedIds` start at 0 so a tracked account with no holdings still reports a
 * portfolio of zero rather than dropping out of the map.
 *
 * @param {readonly Holding[] | null | undefined} holdings
 * @param {PriceMap | null | undefined} prices
 * @param {readonly string[]} [seedIds]
 * @returns {Map<string, number>}
 */
export function portfolioValueByAccount(holdings, prices, seedIds = []) {
  const out = new Map();
  for (const id of seedIds) out.set(id, 0);
  for (const h of holdings || []) {
    out.set(h.accountId, (out.get(h.accountId) || 0) + holdingValue(h, prices));
  }
  return out;
}
