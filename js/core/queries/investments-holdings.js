// js/core/queries/investments-holdings.js — the Investments page's figures:
// the holdings of the tracked investment accounts, their totals, the
// allocation and invested-over-time cards, and each account's balance beside
// what its holdings are worth.
//
// Tracked = type investment, not archived, not opted out (trackInvestments
// false). The holdings are the stored rows, overrides and manual rows, not a
// lens; only each account's balance follows the lens. A zero holding (worth
// under a cent and no units) is left out of `holdings` and of the accounts'
// values unless `includeZero`; the totals, counts and allocation read every
// holding.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows } from '../lens-input.js';
import { NONE } from '../projection.js';
import { trackedHoldings } from '../portfolio.js';
import { holdingValue, holdingPrice, holdingMarkPrice, summarizeHoldings } from '../../engine/holdings.js';
import { computeAccountBalances } from '../../engine/balances.js';
import { txAbsAmount } from '../../engine/tx-amounts.js';
import { round2 } from '../../utils.js';

/**
 * Worth under a cent and no units: a sold-out position or an empty
 * watchlist entry.
 * @param {any} h  a holding
 * @param {any} prices
 */
const isZero = (h, prices) => Math.abs(holdingValue(h, prices)) < 0.005 && Math.abs(h.units) < 1e-6;

/**
 * Market value per symbol across every holding with a price and units,
 * largest first, labelled "Name (SYM)" when a holding names it.
 * @param {any[]} holdings
 * @param {any} prices
 * @returns {{ symbol: string, label: string, value: number }[]}
 */
function allocation(holdings, prices) {
  /** @type {Map<string, { value: number, label: string, symbol: string }>} */
  const bySymbol = new Map();
  for (const h of holdings) {
    const price = holdingPrice(h, prices);
    if (price === null) continue;
    const v = h.units * price;
    if (v <= 0) continue;
    const cur = bySymbol.get(h.symbol) || { value: 0, label: h.symbol, symbol: h.symbol };
    cur.value += v;
    if (h.name && cur.label === cur.symbol) cur.label = h.name;
    bySymbol.set(h.symbol, cur);
  }
  return [...bySymbol.values()]
    .sort((x, y) => y.value - x.value)
    .map(e => ({ symbol: e.symbol, label: e.label === e.symbol ? e.symbol : `${e.label} (${e.symbol})`, value: round2(e.value) }));
}

/**
 * Net cash invested (buys less sells; dividends left out) at each month from
 * the first investment's month through `now`'s, carried forward, never below
 * zero. Every investment row, whatever its account.
 * @param {any[]} transactions
 * @param {Date} now
 * @returns {{ month: string, value: number }[]}
 */
function investedOverTime(transactions, now) {
  /** @type {Map<string, number>} */
  const buckets = new Map();
  const ordered = transactions
    .filter(tx => tx?.type === 'investment_transfer' && tx.direction !== 'dividend')
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let running = 0;
  for (const tx of ordered) {
    const cash = txAbsAmount(tx);
    if (tx.direction === 'sell') running -= cash;
    else running += cash;
    const key = (tx.date || '').slice(0, 7);
    if (key) buckets.set(key, running);
  }
  if (buckets.size === 0) return [];
  const firstKey = [...buckets.keys()].sort()[0];
  const out = [];
  let lastKnown = 0;
  for (let d = new Date(Number(firstKey.slice(0, 4)), Number(firstKey.slice(5, 7)) - 1, 1);
    d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (buckets.has(month)) lastKnown = /** @type {number} */ (buckets.get(month));
    out.push({ month, value: round2(Math.max(0, lastKnown)) });
  }
  return out;
}

export default {
  name: 'investments.holdings',
  summary: 'The tracked investment accounts\' holdings (not archived, not opted out): per holding its units, cost basis, realized gain, distributions, price (null without one) and markPrice (null when it cannot be marked: no price or no units; then it is held at cost). Value-only holdings carry valuationOnly: true; their current value counts but their costs and gains are excluded from totals. totals (cost, value at market with cost for unpriced holdings, valuePriced and unrealized over the priced holdings, unrealizedPct of their cost, the counts), allocation (market value per symbol), invested (net cash invested per month) and per account its balance through the lens, the value of its listed holdings and the gap between the two. Zero holdings are listed only with includeZero.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      includeZero: { type: 'boolean', default: false, description: 'List the zero holdings (sold out, empty watchlist entries) too, and count them in the accounts\' values (default false)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, includeZero: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const view = lensRows(data, input, ctx);
    if (!view.ok) return view;
    const { lens, horizon, txs } = view.value;
    const { holdings: all, prices, accounts } = trackedHoldings(data, (data.accounts || NONE).filter((/** @type {any} */ a) => a && !a.archived));

    const totals = summarizeHoldings(all, prices);
    const zeroCount = all.filter(h => isZero(h, prices)).length;
    const shown = input.includeZero ? all : all.filter(h => !isZero(h, prices));
    const balances = computeAccountBalances(data.accounts || NONE, txs);

    return ok({
      lens,
      horizon,
      holdings: shown.map(h => ({
        accountId: h.accountId,
        symbol: h.symbol,
        name: h.name ?? null,
        units: h.units,
        costBasis: round2(h.costBasis),
        ...(h.valuationOnly ? { valuationOnly: true } : {}),
        realized: round2(h.realized ?? 0),
        distributions: round2(h.distributions ?? 0),
        oversoldUnits: h.oversoldUnits ?? 0,
        overridden: !!h.overridden,
        price: holdingPrice(h, prices),
        markPrice: holdingMarkPrice(h, prices),
        zero: isZero(h, prices),
      })),
      totals: {
        cost: round2(totals.cost),
        costPriced: round2(totals.costPriced),
        value: round2(totals.value),
        valuePriced: round2(totals.valuePriced),
        unrealized: round2(totals.unrealized),
        unrealizedPct: round2(totals.unrealizedPct),
        priced: totals.priced,
        missingPrice: totals.missingPrice,
        activeCount: all.length - zeroCount,
        zeroCount,
      },
      allocation: allocation(all, prices),
      accounts: accounts.map((/** @type {any} */ a) => {
        const balance = balances.get(a.id) || 0;
        let value = 0;
        for (const h of shown) if (h.accountId === a.id) value += holdingValue(h, prices);
        return { id: a.id, balance: round2(balance), value: round2(value), gap: round2(balance - value) };
      }),
      invested: investedOverTime(data.transactions || NONE, ctx.now),
    });
  },
};
