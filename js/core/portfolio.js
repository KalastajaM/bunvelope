// js/core/portfolio.js — the tracked investment holdings and their valuation,
// used by the account detail, net worth and investment queries. Pages receive
// their valuation figures from those queries. `data` is a session snapshot
// with `accounts`, `transactions` and `meta`.

import { listHoldings, portfolioValueByAccount, summarizeHoldings } from '../engine/holdings.js';
import { getInvestmentsMeta } from './investments-meta.js';

/**
 * The tracked investment accounts out of `accounts`: type `investment`, not
 * opted out via `trackInvestments: false`. Archived-account policy stays with
 * the caller — the accounts page lists them, the dashboard's P/L headline
 * does not — so it passes the list it already has.
 */
export function trackedInvestmentAccounts(accounts) {
  return (accounts || []).filter(
    a => a && a.type === 'investment' && a.trackInvestments !== false,
  );
}

/**
 * Holdings belonging to the tracked accounts in `accounts`, with the prices
 * needed to value them: `{ holdings, prices, accounts }`.
 *
 * The dashboard and the accounts page each grew their own copy of this walk
 * and of the valuation loop after it; both read from here now, so a change to
 * what "tracked" means, or to how a position is valued, lands on both at once.
 */
export function trackedHoldings(data, accounts = data?.accounts) {
  const tracked = trackedInvestmentAccounts(accounts);
  const inv = getInvestmentsMeta(data?.meta);
  if (!tracked.length) return { holdings: [], prices: inv.prices, accounts: tracked };
  const ids = new Set(tracked.map(a => a.id));
  const holdings = listHoldings(data?.transactions || [], inv.holdingOverrides, inv.manualRows)
    .filter(h => ids.has(h.accountId));
  return { holdings, prices: inv.prices, accounts: tracked };
}

/**
 * `Map<accountId, market value>` over the tracked accounts in `accounts`.
 * Every tracked account is present, at 0 when it holds nothing, so its card
 * shows "Portfolio €0,00" instead of dropping the line.
 */
export function portfolioByAccount(data, accounts = data?.accounts) {
  const { holdings, prices, accounts: tracked } = trackedHoldings(data, accounts);
  return portfolioValueByAccount(holdings, prices, tracked.map(a => a.id));
}

/** Cost/value/unrealized totals over the tracked accounts in `accounts`. */
export function portfolioSummary(data, accounts = data?.accounts) {
  const { holdings, prices } = trackedHoldings(data, accounts);
  return summarizeHoldings(holdings, prices);
}

/**
 * Accounts whose sales are not taxed one by one: pension insurance and
 * accounts marked tax-wrapped (an equity savings account). Archived accounts
 * are not left out: a sale made before the archive still counts in its year.
 *
 * @param {any[] | null | undefined} accounts
 * @returns {Set<string>}
 */
export function taxExemptAccountIds(accounts) {
  return new Set((accounts || [])
    .filter(a => a && (a.pensionInsurance === true || a.taxWrapped === true))
    .map(a => a.id));
}
