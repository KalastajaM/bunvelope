// js/core/investment-fields.js — the pure rules for what meta.investments
// stores: symbol and payee keys, rounding, the price history and the manual
// row shape. Shared by the investment.* commands and js/state/investments.js,
// which re-exports them for its callers. Pure: no state, no clock.

import { getInvestmentsMeta } from './investments-meta.js';
import { deepEqual } from './diff.js';

/** A symbol as stored: trimmed, uppercase. */
export const symbolKey = (s) => String(s || '').trim().toUpperCase();

/** A payee rule key: trimmed, lowercase. */
export function normalisePayeeKey(payee) {
  return String(payee || '').trim().toLowerCase();
}

// Default payee strings that add-tx falls back to when the user leaves the
// payee blank. They're too generic to be a useful auto-mapping key.
const PAYEE_PLACEHOLDERS = new Set(['investment', 'investment sale']);

export function isMappablePayee(payee) {
  const key = normalisePayeeKey(payee);
  return !!key && !PAYEE_PLACEHOLDERS.has(key);
}

/** Prices are stored to 5 decimals, units to 6, cost basis to cents. */
export const roundPrice = (n) => Math.round(n * 100000) / 100000;
export const roundUnits = (n) => Math.round(n * 1e6) / 1e6;
export const roundCost = (n) => Math.round(n * 100) / 100;

// Points kept per symbol: ten years of daily refreshes.
const PRICE_HISTORY_CAP = 3660;

/**
 * `history` with `{ date, price }` recorded: a point already on that date is
 * replaced (the last price of a day wins), the result is date-ordered, and
 * only the newest PRICE_HISTORY_CAP points are kept. Returns a new array.
 *
 * @param {Array<{ date: string, price: number }> | undefined} history
 * @param {string} date  YYYY-MM-DD
 * @param {number} price
 * @returns {Array<{ date: string, price: number }>}
 */
export function appendPricePoint(history, date, price) {
  const day = String(date || '').slice(0, 10);
  const kept = (Array.isArray(history) ? history : [])
    .filter(p => p && typeof p.date === 'string' && p.date !== day);
  kept.push({ date: day, price });
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return kept.length > PRICE_HISTORY_CAP ? kept.slice(kept.length - PRICE_HISTORY_CAP) : kept;
}

/**
 * The stored price entry: rounded, dated, with the conversion it came from
 * when `fx` is a valid `{ currency, price, rate }` (none drops an earlier one).
 * @param {number} price
 * @param {string} asOf
 * @param {any} [fx]
 */
export function priceEntry(price, asOf, fx = null) {
  /** @type {{ price: number, asOf: string, fx?: { currency: string, price: number, rate: number } }} */
  const entry = { price: roundPrice(price), asOf };
  if (fx && typeof fx.currency === 'string' && Number.isFinite(fx.price) && Number.isFinite(fx.rate)) {
    entry.fx = { currency: fx.currency, price: fx.price, rate: fx.rate };
  }
  return entry;
}

/**
 * The stored holding override: rounded units and cost basis; name and price
 * URL only when non-empty.
 * @param {{ units: number, costBasis: number, name?: string, priceUrl?: string, valuationOnly?: boolean }} override
 */
export function holdingOverrideEntry(override) {
  /** @type {{ units: number, costBasis: number, name?: string, priceUrl?: string, valuationOnly?: boolean }} */
  const next = { units: roundUnits(override.units), costBasis: roundCost(override.costBasis) };
  if (override.valuationOnly === true) next.valuationOnly = true;
  if (override.name && String(override.name).trim()) next.name = String(override.name).trim();
  if (override.priceUrl && String(override.priceUrl).trim()) next.priceUrl = String(override.priceUrl).trim();
  return next;
}

/**
 * The stored shape of a manual row, shared by add and update: direction
 * defaults to buy, and buy/sell magnitudes are clamped at zero.
 * @param {any} row
 * @param {string} id
 */
export function normalizeManualRow(row, id) {
  const dir = row?.direction === 'sell' ? 'sell'
            : row?.direction === 'adjust' ? 'adjust'
            : 'buy';
  const u = Number(row?.units);
  const a = Number(row?.amount);
  const unitsVal = dir === 'adjust'
    ? (Number.isFinite(u) ? u : 0)
    : Math.max(0, Number.isFinite(u) ? u : 0);
  const amountVal = dir === 'adjust'
    ? (Number.isFinite(a) ? a : 0)
    : Math.max(0, Number.isFinite(a) ? a : 0);
  return {
    id,
    date: String(row?.date || '').slice(0, 10),
    direction: dir,
    units: unitsVal,
    amount: amountVal,
    ...(row?.note ? { note: String(row.note) } : {}),
  };
}

/**
 * `transactions` with `symbol` (already a symbolKey) and `modified_at` set on
 * the rows whose id is in `ids`, and nothing else changed: the tag the
 * unmapped-payees card and the add/edit backfill have always stored. No row is
 * re-validated, so a legacy row the engine accepts (a sell without units, a
 * row without a direction) is tagged like any other. A row that already
 * carries the symbol is left as it is. Returns the new array (the same one
 * when nothing changed) and how many rows were tagged.
 * @param {any[]} transactions
 * @param {Iterable<string>} ids
 * @param {string} sym
 * @param {string} stamp  ISO timestamp for modified_at
 * @returns {{ transactions: any[], tagged: number }}
 */
export function tagRowsWithSymbol(transactions, ids, sym, stamp) {
  const targets = new Set(ids);
  let tagged = 0;
  const next = transactions.map(t => {
    if (!targets.has(t.id) || t.symbol === sym) return t;
    tagged++;
    return { ...t, symbol: sym, modified_at: stamp };
  });
  return { transactions: tagged ? next : transactions, tagged };
}

/**
 * Field errors for `ids` that name no transaction in `transactions`, at
 * `path[i]`.
 * @param {any[]} transactions
 * @param {string[]} ids
 * @param {string} path
 * @returns {{ path: string, message: string }[]}
 */
export function unknownTxIds(transactions, ids, path) {
  const known = new Set(transactions.map(t => t.id));
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  ids.forEach((id, i) => {
    if (!known.has(id)) errors.push({ path: `${path}[${i}]`, message: `no transaction with id "${id}"` });
  });
  return errors;
}

/** The `row` input of investment.addManualRow and updateManualRow. */
export const MANUAL_ROW_SCHEMA = Object.freeze({
  type: 'object',
  required: ['date'],
  properties: {
    date: { type: 'date', description: 'Date of the correction, YYYY-MM-DD' },
    direction: { enum: ['buy', 'sell', 'adjust'], default: 'buy', description: 'buy and sell take magnitudes (negatives count as 0); adjust takes signed deltas with no cash leg' },
    units: { type: 'number', description: 'Units bought or sold, or the units delta of an adjust' },
    amount: { type: 'number', description: 'Cash side including any fee, or the cost-basis delta of an adjust' },
    note: { type: 'string' },
  },
});

/**
 * `meta` with `mutate` applied to a copy of its investments, stored in the
 * full five-part shape as the state writers store it; null when nothing
 * changes.
 * @param {Record<string, any>} meta
 * @param {(inv: ReturnType<typeof getInvestmentsMeta>) => ReturnType<typeof getInvestmentsMeta>} mutate
 * @returns {Record<string, any> | null}
 */
export function investmentsPatch(meta, mutate) {
  const cur = getInvestmentsMeta(meta);
  const next = mutate(structuredClone(cur));
  return deepEqual(next, cur) ? null : { ...meta, investments: next };
}
