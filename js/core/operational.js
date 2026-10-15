// js/core/operational.js — the "operating money" scope of the Dashboard's
// Spending accounts KPI and its Age of Money: the spending accounts (engine
// `isSpendingAccount`: bank, cash and credit cards unless an account says
// otherwise), archived ones INCLUDED, and the rows that move them. Savings and
// investment accounts are tracked by the net worth figures and must not
// dilute that signal.
//
// Each view is memoised on the identity of the arrays it derives from. A fresh
// array per call defeats every downstream memo: js/engine/balance-cache.js and
// the Age-of-Money prep cache key on array identity. The session publishes new
// arrays on write and never mutates them in place, so a changed input is a
// changed key.

import { isSpendingAccount } from '../engine/balances.js';
import { aomPoolTransactions } from '../engine/history.js';

const opAccountsCache   = new WeakMap(); // accounts -> filtered accounts
const opAccountIdsCache = new WeakMap(); // accounts -> Set of ids
const opTxCache         = new WeakMap(); // transactions -> WeakMap<accounts, txs>
/** @type {any[]} */
const EMPTY_ARR = /** @type {any} */ (Object.freeze([]));

/**
 * Ids of the spending accounts, archived included.
 * @param {any[] | null | undefined} accounts
 * @returns {Set<string>}
 */
export function operationalAccountIds(accounts) {
  const list = accounts || EMPTY_ARR;
  let ids = opAccountIdsCache.get(list);
  if (ids) return ids;
  ids = new Set();
  for (const a of list) {
    if (isSpendingAccount(a)) ids.add(a.id);
  }
  opAccountIdsCache.set(list, ids);
  return ids;
}

/**
 * The spending accounts, archived included, in array order.
 * @param {any[] | null | undefined} accounts
 * @returns {any[]}
 */
export function operationalAccounts(accounts) {
  const list = accounts || EMPTY_ARR;
  let filtered = opAccountsCache.get(list);
  if (filtered) return filtered;
  filtered = list.filter(isSpendingAccount);
  opAccountsCache.set(list, filtered);
  return filtered;
}

/**
 * The rows of the operating-money scope: an income or expense row counts only
 * when its account is operational (a dividend or an automated deposit landing
 * on savings must not inflate Age of Money or skew the cushion); every other
 * row is kept.
 *
 * Depends on both arrays (the account list decides which ids count), so the
 * memo is keyed on both.
 *
 * @param {any[] | null | undefined} accounts
 * @param {any[] | null | undefined} transactions
 * @returns {any[]}
 */
export function operationalTransactions(accounts, transactions) {
  const txs = transactions || EMPTY_ARR;
  const list = accounts || EMPTY_ARR;
  let byAccounts = opTxCache.get(txs);
  if (!byAccounts) { byAccounts = new WeakMap(); opTxCache.set(txs, byAccounts); }
  const hit = byAccounts.get(list);
  if (hit) return hit;

  const opIds = operationalAccountIds(list);
  const filtered = txs.filter(tx => {
    if (tx.type === 'income' || tx.type === 'expense') {
      return opIds.has(tx.account);
    }
    return true;
  });
  byAccounts.set(list, filtered);
  return filtered;
}

/**
 * The operating rows for Age of Money: `operationalTransactions` with every
 * transfer that crosses the spending accounts' edge marked as an inflow or an
 * outflow (engine `aomPoolTransactions`). Salary moved on to savings then
 * consumes the oldest money; a transfer between two spending accounts (a card
 * payment) stays neutral. Memoised through the two views it reads.
 *
 * @param {any[] | null | undefined} accounts
 * @param {any[] | null | undefined} transactions
 * @returns {any[]}
 */
export function operationalAomTransactions(accounts, transactions) {
  return aomPoolTransactions(operationalTransactions(accounts, transactions), operationalAccountIds(accounts));
}
