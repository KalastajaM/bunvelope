// Recorded securities performance, independent of account-balance adjustments.
// Pure: prices and the requested dates are supplied by the query.
import { manualRowsAsTransactions, txSymbol } from './holdings.js';
import { txAbsAmount, txDirection } from './tx-amounts.js';
import { round2, validateAmount } from '../utils.js';

/** UTC day ordinal of an ISO calendar date (no DST or ambient clock).
 * @param {string} date @returns {number} */
function day(date) { return Date.parse(`${date}T00:00:00Z`) / 86400000; }
/** @param {unknown} value @returns {value is string} */
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const n = day(value);
  return Number.isFinite(n) && new Date(n * 86400000).toISOString().slice(0, 10) === value;
}

/**
 * Modified Dietz: (ending - opening - net flows) / time-weighted capital.
 * Flows are positive into the securities portfolio and negative out. Recorded
 * cash flows occur at day end; opening is before the first day's trades.
 * @param {number} opening @param {number} closing
 * @param {{ date: string, amount: number }[]} flows
 * @param {string} from @param {string} to
 */
export function modifiedDietz(opening, closing, flows, from, to) {
  const days = day(to) - day(from) + 1;
  if (!Number.isFinite(days) || days <= 0) throw new RangeError('Invalid performance period');
  let net = 0, weighted = 0;
  for (const flow of flows) {
    net += flow.amount;
    weighted += flow.amount * (day(to) - day(flow.date)) / days;
  }
  const gain = closing - opening - net;
  const capital = opening + weighted;
  return { gain, weightedCapital: capital, returnPct: capital > 0.005 ? gain / capital * 100 : null };
}

/** Latest valid recorded price on/before a boundary, never a future quote.
 * @param {any} inv @param {string} symbol @param {string} boundary
 */
function priceAt(inv, symbol, boundary) {
  const points = [...(Array.isArray(inv.priceHistory?.[symbol]) ? inv.priceHistory[symbol] : [])];
  const current = inv.prices?.[symbol];
  if (current) points.push({ date: current.asOf, price: current.price });
  const eligible = points.filter(p => validDate(p?.date) && p.date <= boundary &&
    typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0);
  eligible.sort((a, b) => a.date.localeCompare(b.date));
  return eligible.at(-1) || null;
}

/**
 * Every selected holding must have reconstructible units and boundary prices.
 * No current-price backfill, cost-basis substitution, or undated override is
 * allowed to fabricate a historical valuation. Manual buy/sell correction rows
 * are explicit dated cash flows; adjust rows change units without a cash leg.
 * Fees are already included in transaction cash: never deduct them twice.
 * @param {{ transactions?: any[], meta?: any, accounts?: any[] }} data
 * @param {{ from: string, to: string, accountIds: string[], maxPriceAgeDays?: number }} input
 */
export function investmentPerformance(data, input) {
  const { from, to, accountIds, maxPriceAgeDays = 7 } = input;
  if (!validDate(from) || !validDate(to) || from > to) throw new RangeError('Invalid performance period');
  const openingDate = new Date((day(from) - 1) * 86400000).toISOString().slice(0, 10);
  const inv = data.meta?.investments || {};
  const ids = new Set(accountIds);
  /** @type {Map<string, {accountId: string, symbol: string, openingUnits: number, closingUnits: number, hasUnits: boolean, validUnits: boolean}>} */
  const positions = new Map();
  /** @type {{code: string, accountId: string|null, symbol: string|null, date: string|null, blocking: boolean, transactionId?: string, manualRowId?: string}[]} */
  const issues = [];
  const issue = (/** @type {string} */ code, /** @type {string|null} */ accountId, /** @type {string|null} */ symbol,
    /** @type {string|null} */ date = null, blocking = true) => issues.push({ code, accountId, symbol, date, blocking });
  /** @type {{date: string, amount: number, kind: string, accountId: string, symbol: string, manual: boolean}[]} */
  const flows = [];
  let contributions = 0, withdrawals = 0, dividends = 0;
  const rows = [...(data.transactions || []), ...manualRowsAsTransactions(inv.manualRows)]
    .filter(tx => tx?.type === 'investment_transfer' && tx.posted !== false && !tx.is_forecast)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) ||
      Number(txDirection(a) === 'sell') - Number(txDirection(b) === 'sell'));
  for (const tx of rows) {
    const direction = txDirection(tx);
    const accountId = direction === 'buy' ? tx.to_account : tx.from_account;
    if (!ids.has(accountId)) continue;
    const symbol = txSymbol(tx);
    const date = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    // Keep provenance so every surface can open the exact source, even when dates collide.
    const tradeIssue = code => {
      issue(code, accountId, symbol || null, validDate(date) ? date : null);
      const diagnostic = issues.at(-1);
      if (tx.id && diagnostic) diagnostic[tx._manual ? 'manualRowId' : 'transactionId'] = tx.id;
    };
    if (!validDate(date)) { tradeIssue('invalid_date'); continue; }
    if (date > to) continue;
    if (!symbol) { tradeIssue('missing_symbol'); continue; }
    const key = JSON.stringify([accountId, symbol]);
    let position = positions.get(key);
    if (!position) {
      position = { accountId, symbol, openingUnits: 0, closingUnits: 0, hasUnits: false, validUnits: true };
      positions.set(key, position);
    }
    const units = Number(tx.units);
    const cash = txAbsAmount(tx);
    const cashValid = validateAmount(tx.amount) !== null;
    if (direction !== 'adjust' && !cashValid) {
      tradeIssue('invalid_cash');
    }
    let delta = 0;
    if (direction === 'buy' || direction === 'sell') {
      if (!Number.isFinite(units) || units <= 0) {
        position.validUnits = false; tradeIssue('missing_units');
      }
      else delta = direction === 'buy' ? units : -units;
    } else if (direction === 'adjust') {
      if (!Number.isFinite(units) || tx.units == null || tx.units === '') {
        position.validUnits = false; tradeIssue('missing_units');
      }
      else delta = units;
      if (date >= from) tradeIssue('manual_adjustment');
    }
    if (delta !== 0) position.hasUnits = true;
    position.closingUnits += delta;
    if (position.closingUnits < -1e-6) {
      position.validUnits = false; tradeIssue('oversold_units');
    }
    if (date < from) position.openingUnits += delta;
    if (date >= from && direction !== 'adjust' && cashValid) {
      const amount = direction === 'buy' ? cash : -cash;
      flows.push({ date, amount, kind: direction, accountId, symbol, manual: !!tx._manual });
      if (direction === 'buy') contributions += cash;
      else if (direction === 'sell') withdrawals += cash;
      else dividends += cash;
    }
  }
  for (const accountId of accountIds) {
    for (const [symbol, override] of Object.entries(inv.holdingOverrides?.[accountId] || {})) {
      const key = JSON.stringify([accountId, symbol]);
      const ov = /** @type {any} */ (override);
      if (!positions.get(key)?.hasUnits && (Number(ov?.units ?? 0) !== 0 || Number(ov?.costBasis ?? 0) !== 0)) {
        issue('undated_holding', accountId, symbol);
      }
    }
  }
  let opening = 0, closing = 0;
  const holdings = [...positions.values()].map(position => {
    const value = (/** @type {number} */ units, /** @type {string} */ date) => {
      if (!position.validUnits || units < -1e-6) return null;
      if (Math.abs(units) < 1e-6) return { value: 0, price: null, priceDate: null };
      const point = priceAt(inv, position.symbol, date);
      if (!point) { issue('missing_price', position.accountId, position.symbol, date); return null; }
      if (day(date) - day(point.date) > maxPriceAgeDays) {
        issue('stale_price', position.accountId, position.symbol, date); return null;
      }
      if (point.date !== date) issue('carried_price', position.accountId, position.symbol, point.date, false);
      return { value: units * point.price, price: point.price, priceDate: point.date };
    };
    const start = value(position.openingUnits, openingDate);
    const end = value(position.closingUnits, to);
    opening += start?.value || 0;
    closing += end?.value || 0;
    return { ...position, opening: start, closing: end };
  });
  const complete = !issues.some(i => i.blocking);
  const result = complete ? modifiedDietz(opening, closing, flows, from, to) : null;
  if (complete && result?.returnPct === null) issue('no_weighted_capital', null, null, null, false);
  const rounded = (/** @type {number|null|undefined} */ n) => n == null || !Number.isFinite(n) ? null : round2(n);
  return {
    from, to, openingDate, method: 'modified_dietz', maxPriceAgeDays, accountIds, complete,
    openingValue: complete ? rounded(opening) : null, closingValue: complete ? rounded(closing) : null,
    contributions: round2(contributions), withdrawals: round2(withdrawals), dividends: round2(dividends),
    netContributions: round2(contributions - withdrawals - dividends),
    gain: rounded(result?.gain), weightedCapital: rounded(result?.weightedCapital), returnPct: rounded(result?.returnPct),
    holdings, flows, issues,
  };
}
