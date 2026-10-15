// js/pages/net-worth-whatif.js — DOM-free helpers for the Net worth page's
// what-if editor (spec 2026-09-28-what-if-scenarios-design.md): the income
// items a change can target, and default values for a freshly-added change.
//
// The scenario runs themselves are the queries' (forecast.simulation and
// netWorth.projection take a scenario id): they look the scenario up and
// pass `simulate` the memoised scenario object and the module-level stress
// cut its cache keys on (js/core/projection.js).
//
// Pure. No DOM, no `app.js` import.

import { isIncomeLikeItem, isSpendingAccount } from '../engine.js';
import { SCENARIOS } from '../engine/stress.js';

/**
 * The income-like plan items a what-if income change can target — the same
 * definition `applyScenario` scales by (`isIncomeLikeItem`), so every item
 * offered in the editor is one an `itemId` change actually matches.
 * @param {any[]} budgetItems
 * @returns {any[]}
 */
export function incomeItemsFor(budgetItems) {
  // A Disabled item produces no rows, so targeting it would do nothing.
  return (budgetItems || []).filter(it => isIncomeLikeItem(it) && it.include !== false);
}

/** `YYYY-MM` for the month after `today`. @param {Date} today @returns {string} */
export function nextMonthOf(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const ny = m === 11 ? y + 1 : y;
  const nm = (m + 1) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` for `today`. @param {Date} today @returns {string} */
export function todayYmdOf(today) {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/**
 * The account a new change starts with: the first non-archived spending
 * account, or failing that the first non-archived account, or null.
 * @param {any[]} accounts
 * @returns {string | null}
 */
export function defaultAccountId(accounts) {
  const live = (accounts || []).filter(a => a && !a.archived);
  return (live.find(isSpendingAccount) ?? live[0])?.id ?? null;
}

/**
 * A freshly-added change of `type`, defaulted per the spec: from = next
 * month, day = 1, account = the first non-archived spending account.
 * @param {'income' | 'monthly' | 'oneoff' | 'stress'} type
 * @param {{ today: Date, accounts: any[] }} ctx
 * @returns {import('../engine/whatif.js').WhatIfChange | null}
 */
export function defaultChange(type, { today, accounts }) {
  const from = nextMonthOf(today);
  const account = defaultAccountId(accounts);
  if (type === 'income') return { type: 'income', pct: 0, from };
  if (type === 'monthly') return { type: 'monthly', amount: 0, account, from, day: 1 };
  if (type === 'oneoff') return { type: 'oneoff', date: todayYmdOf(today), amount: 0, account, label: '' };
  if (type === 'stress') return { type: 'stress', scenario: SCENARIOS[0], from };
  return null;
}
