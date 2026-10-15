// js/core/projection.js — the Net worth projection's per-account rules, moved
// out of the page (js/pages/net-worth.js) so the queries compute them:
//
//   growthFor               the yearly rate an account grows by, and why
//   contributionFor         the monthly amount the long projection adds
//   readContributionSource  the saved plan/history choice, 'plan' unless valid
//   loanSchedulesFor        each loan's repayment schedule, from its plan item
//   loanPaths               those schedules as month-end balances
//   amountsOf               an account's two contribution suggestions
//   contributionTable       the table's rows (which are shown) and its sums
//   planGap                 whether the plan adds far less than recent months
//   accountsWithOverrides   unsaved growth/contribution edits over the accounts
//                           (ACCOUNT_OVERRIDES_INPUT, their input schema)
//   withAccountOverrides    the data a walk reads, with those edits over it
//   whatIfScenarios         the saved what-if scenarios, cleaned
//
// and what the Net worth queries share for their figures:
//
//   NET_WORTH_PARTS         the total and its parts, in answer order
//   NONE                    one frozen empty array for a missing collection
//   countedAccounts         the accounts less the excluded ones
//   roundedPoint            a dated net worth split, money rounded
//
// accountsWithOverrides and whatIfScenarios are memoised one slot, because
// `simulate` caches on the identity of its inputs (js/engine/simulation.js):
// a fresh accounts array or scenario object per call would re-walk 24 months
// every time. The projection's own inputs that do not change with its years
// or source (the 12-month averages, the loan schedules and, per years, their
// paths) are memoised one slot too (cachedAverages, cachedLoanSchedules,
// cachedLoanPaths), so a horizon or source toggle recomputes neither. Pure
// apart from those cache slots; no clock (`today` is a parameter).

import { computeAnnualInterest } from '../engine/tx-amounts.js';
import { isAssetAccount, averageMonthlyContribution } from '../engine/balances.js';
import { loanRepayment, loanBalancePath } from '../engine/loan-schedule.js';
import { normalizeScenarios } from '../engine/whatif.js';
import { round2 } from '../utils.js';
import { ACCOUNT_FIELD_PROPERTIES } from './entity-fields.js';

/** The net worth split's total and parts, in the order answers list them. */
export const NET_WORTH_PARTS = /** @type {const} */ (['total', 'spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other']);

/** A missing collection: one frozen empty array, so the identity stays put. */
export const NONE = /** @type {any[]} */ (/** @type {unknown} */ (Object.freeze([])));

/**
 * The accounts less those in `excludeIds` (the page filter). With nothing
 * excluded, the array itself: the balance and simulation caches key on its
 * identity.
 *
 * @param {any[]} accounts
 * @param {string[] | undefined} excludeIds
 * @returns {any[]}
 */
export function countedAccounts(accounts, excludeIds) {
  const excluded = new Set(excludeIds || []);
  return excluded.size ? accounts.filter(a => !excluded.has(a?.id)) : accounts;
}

/**
 * A one-slot memo: `compute` runs again only when a key differs, by
 * identity, from the last call's.
 *
 * @template T
 * @returns {(key: unknown[], compute: () => T) => T}
 */
function oneSlot() {
  /** @type {{ key: unknown[], value: T } | null} */
  let slot = null;
  return (key, compute) => {
    if (slot && slot.key.length === key.length && slot.key.every((k, i) => k === key[i])) return slot.value;
    const value = compute();
    slot = { key, value };
    return value;
  };
}

/** The exclusions as one comparable key. @param {string[] | undefined} ids */
const excludeKey = (ids) => (ids?.length ? JSON.stringify(ids) : '');

/**
 * One dated point of an answer: the split's total and parts, `round2`'d.
 *
 * @param {string} date
 * @param {Record<(typeof NET_WORTH_PARTS)[number], number>} split  a `netWorthFromBalances` /
 *   `computeNetWorthHistory` split
 * @returns {{ date: string, [part: string]: string | number }}
 */
export function roundedPoint(date, split) {
  return { date, ...Object.fromEntries(NET_WORTH_PARTS.map(k => [k, round2(split[k])])) };
}

/**
 * The growth rate a projection uses for an account: its own `expectedGrowth`
 * when set, otherwise a savings account's interest rate from its tiers (at
 * `balance`), otherwise none. `source` says which, for the table.
 *
 * @param {{ expectedGrowth?: number, type?: string, interestTiers?: any[], interestTierMode?: 'progressive'|'full-balance' }} account
 * @param {number} balance
 * @returns {{ pct: number | null, source: 'set' | 'interest' | 'none' }}
 */
export function growthFor(account, balance) {
  if (Number.isFinite(account.expectedGrowth)) return { pct: /** @type {number} */ (account.expectedGrowth), source: 'set' };
  // A loan given's interest is paid out in cash, not added to the loan.
  if (account.type === 'loan_given') return { pct: null, source: 'none' };
  if (Array.isArray(account.interestTiers) && account.interestTiers.length && balance > 0) {
    const annual = computeAnnualInterest(balance, account.interestTiers, account.interestTierMode);
    if (annual > 0) return { pct: round2((annual / balance) * 100), source: 'interest' };
  }
  return { pct: null, source: 'none' };
}

/**
 * The saved choice (Net worth projection prefs), 'plan' unless it is valid.
 * @param {Record<string, any> | null | undefined} prefs
 * @returns {'plan' | 'history'}
 */
export function readContributionSource(prefs) {
  return prefs?.contributionSource === 'history' ? 'history' : 'plan';
}

/**
 * The monthly amount the long projection adds to an account after the
 * simulated 24 months: its own `plannedMonthly` when set; an asset account
 * gets nothing, since its value moves by its growth rate; otherwise, by
 * `source`, the net inflow of the simulation's last year (`plan`: the plan
 * has no one-offs, so a negative figure is honest, but income or transfers
 * missing from the plan are missing here too) or the account's average over
 * the last 12 months (`history`: what actually happened, one-offs included).
 * @param {{ plannedMonthly?: number | null, type?: string }} account
 * @param {{ plan: number, history: number }} amounts
 * @param {'plan' | 'history'} source
 * @returns {{ amount: number, source: 'set' | 'none' | 'plan' | 'history' }}
 */
export function contributionFor(account, amounts, source) {
  if (Number.isFinite(account.plannedMonthly)) return { amount: /** @type {number} */ (account.plannedMonthly), source: 'set' };
  if (isAssetAccount(account)) return { amount: 0, source: 'none' };
  return source === 'history'
    ? { amount: amounts.history, source: 'history' }
    : { amount: amounts.plan, source: 'plan' };
}

/**
 * The repayment schedule of each non-archived loan among `accounts` that one
 * enabled, scheduled plan item repays (`loanRepayment`) and that has a
 * payment ahead. Past the simulated years such a loan follows its schedule
 * instead of growing at a rate.
 *
 * @param {any[]} accounts
 * @param {{ budgetItems?: any[], transactions?: any[], today: Date, country?: string }} ctx
 * @returns {Map<string, import('../engine/loan-schedule.js').LoanSchedule>}
 */
export function loanSchedulesFor(accounts, { budgetItems, transactions, today, country = 'FI' }) {
  /** @type {Map<string, import('../engine/loan-schedule.js').LoanSchedule>} */
  const out = new Map();
  for (const a of accounts || []) {
    if (!a || a.type !== 'loan' || a.archived) continue;
    const r = loanRepayment(a, { budgetItems, transactions, today, country });
    if (r.status === 'ok' && r.schedule.rows.length) out.set(a.id, r.schedule);
  }
  return out;
}

/**
 * Each schedule's month-end balances (`loanBalancePath`, `months` + 1
 * entries from the end of `today`'s month), the `scheduled` input of
 * `projectFromSimulation`.
 *
 * @param {Map<string, import('../engine/loan-schedule.js').LoanSchedule>} schedules
 * @param {Date} today
 * @param {number} months
 * @returns {Map<string, number[]>}
 */
export function loanPaths(schedules, today, months) {
  return new Map([...schedules].map(([id, sch]) => [id, loanBalancePath(sch, today, months)]));
}

/** @type {(key: unknown[], compute: () => Map<string, number>) => Map<string, number>} */
const averagesSlot = oneSlot();
/** @type {(key: unknown[], compute: () => Map<string, import('../engine/loan-schedule.js').LoanSchedule>) => Map<string, import('../engine/loan-schedule.js').LoanSchedule>} */
const schedulesSlot = oneSlot();
/** @type {(key: unknown[], compute: () => Map<string, number[]>) => Map<string, number[]>} */
const pathsSlot = oneSlot();

/**
 * Each account's average monthly net inflow over the last 12 months
 * (`averageMonthlyContribution`), for `accounts` less `excludeIds`.
 * Memoised one slot on the accounts' and transactions' identities, the
 * exclusions and the day.
 *
 * @param {any[]} accounts  the stored accounts
 * @param {string[] | undefined} excludeIds
 * @param {any[]} transactions
 * @param {Date} today
 * @returns {Map<string, number>}
 */
export function cachedAverages(accounts, excludeIds, transactions, today) {
  return averagesSlot([accounts, excludeKey(excludeIds), transactions, today.getTime()],
    () => averageMonthlyContribution(countedAccounts(accounts, excludeIds), transactions, today, 12));
}

/**
 * `loanSchedulesFor` the accounts less `excludeIds`, memoised one slot on
 * the accounts', budget items' and transactions' identities, the
 * exclusions, the day and the country.
 *
 * @param {any[]} accounts  the stored accounts
 * @param {string[] | undefined} excludeIds
 * @param {{ budgetItems: any[], transactions: any[], today: Date, country: string }} ctx
 * @returns {Map<string, import('../engine/loan-schedule.js').LoanSchedule>}
 */
export function cachedLoanSchedules(accounts, excludeIds, { budgetItems, transactions, today, country }) {
  return schedulesSlot([accounts, excludeKey(excludeIds), budgetItems, transactions, today.getTime(), country],
    () => loanSchedulesFor(countedAccounts(accounts, excludeIds), { budgetItems, transactions, today, country }));
}

/**
 * `loanPaths`, memoised one slot on the schedules' identity, the day and
 * `months`.
 *
 * @param {Map<string, import('../engine/loan-schedule.js').LoanSchedule>} schedules
 * @param {Date} today
 * @param {number} months
 * @returns {Map<string, number[]>}
 */
export function cachedLoanPaths(schedules, today, months) {
  return pathsSlot([schedules, today.getTime(), months], () => loanPaths(schedules, today, months));
}

/**
 * @typedef {{
 *   account: any, balance: number,
 *   growth: { pct: number | null, source: 'set' | 'interest' | 'none' },
 *   amounts: { plan: number, history: number },
 *   contribution: { amount: number, source: 'set' | 'none' | 'plan' | 'history' },
 *   shown: boolean,
 * }} ContributionRow
 */

/**
 * An account's two contribution suggestions: the net inflow of a run's last
 * simulated year (`plan`) and the last 12 months' average (`history`).
 *
 * @param {string} id
 * @param {Map<string, number>} lastYearContribution  a simulation run's
 * @param {Map<string, number>} averages  from `averageMonthlyContribution`
 * @returns {{ plan: number, history: number }}
 */
export function amountsOf(id, lastYearContribution, averages) {
  return { plan: lastYearContribution.get(id) ?? 0, history: averages.get(id) ?? 0 };
}

/**
 * The projection table's rows and its monthly sums. A row is shown unless it
 * has no balance, no contribution and no rate; the sums are over the shown
 * rows: `used` what the projection adds (by `source`), `plan` what the Plan
 * source would add, `actual` the last 12 months' average.
 *
 * @param {any[]} accounts  the table's accounts, in order
 * @param {{ opening: Map<string, number>, lastYearContribution: Map<string, number>,
 *           averages: Map<string, number>, source: 'plan' | 'history' }} input
 *   `opening` and `lastYearContribution` from the base simulation run;
 *   `averages` from `averageMonthlyContribution`
 * @returns {{ rows: ContributionRow[], used: number, plan: number, actual: number }}
 */
export function contributionTable(accounts, { opening, lastYearContribution, averages, source }) {
  let used = 0, plan = 0, actual = 0;
  /** @type {ContributionRow[]} */
  const rows = [];
  for (const account of accounts) {
    const balance = opening.get(account.id) ?? (Number(account.initialBalance) || 0);
    const growth = growthFor(account, balance);
    const amounts = amountsOf(account.id, lastYearContribution, averages);
    const contribution = contributionFor(account, amounts, source);
    const shown = !(Math.abs(balance) < 0.005 && Math.abs(contribution.amount) < 0.005 && growth.pct === null);
    rows.push({ account, balance, growth, amounts, contribution, shown });
    if (!shown) continue;
    used += contribution.amount;
    plan += contributionFor(account, amounts, 'plan').amount;
    actual += amounts.history;
  }
  return { rows, used: round2(used), plan: round2(plan), actual: round2(actual) };
}

/**
 * Whether the plan adds much less than the last 12 months did: a shortfall of
 * more than half of the actual figure, when that figure is at least 1. It
 * names income or transfers the plan may be missing.
 *
 * @param {{ plan: number, actual: number }} sums
 * @returns {boolean}
 */
export function planGap({ plan, actual }) {
  return Math.abs(actual) >= 1 && actual - plan > Math.abs(actual) / 2;
}

/** @typedef {{ id: string, expectedGrowth?: number | null, plannedMonthly?: number | null }} AccountOverride */

/** The `accountOverrides` input schema of the queries that take it. */
export const ACCOUNT_OVERRIDES_INPUT = Object.freeze({
  type: 'array',
  description: 'Unsaved account edits, laid over the stored accounts in order: a number sets the field, null clears it (a later entry for one id wins a field both set). An unknown id is ignored. Values are expected rounded to two decimals, as the Net worth page sends them and the account fields are stored.',
  items: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Account id' },
      expectedGrowth: { ...ACCOUNT_FIELD_PROPERTIES.expectedGrowth, description: 'Expected growth, % a year' },
      plannedMonthly: { ...ACCOUNT_FIELD_PROPERTIES.plannedMonthly, description: 'Monthly contribution after the simulated months' },
    },
  },
});

const OVERRIDE_FIELDS = /** @type {const} */ (['expectedGrowth', 'plannedMonthly']);

/** @type {{ accounts: any[], key: string, result: any[] } | null} */
let overlayMemo = null;

/**
 * The accounts with unsaved growth and contribution edits over them, as the
 * Net worth page shows an edit before `account.update` lands: a number sets
 * the field, null clears it, a field not given is left alone, and a later
 * entry for one id wins a field both set. An id no account has is ignored.
 * Accounts without an edit are kept by reference; without overrides the
 * array itself is returned.
 *
 * Memoised one slot on the accounts' identity and the overrides' content, so
 * the same edits give the same array and `simulate` hits its cache.
 *
 * @param {any[]} accounts
 * @param {AccountOverride[] | undefined} overrides
 * @returns {any[]}
 */
export function accountsWithOverrides(accounts, overrides) {
  if (!overrides?.length) return accounts;
  const key = JSON.stringify(overrides);
  if (overlayMemo && overlayMemo.accounts === accounts && overlayMemo.key === key) return overlayMemo.result;
  /** @type {Map<string, Record<string, number | null>>} */
  const byId = new Map();
  for (const o of overrides) {
    const fields = { ...byId.get(o.id) };
    for (const f of OVERRIDE_FIELDS) if (o[f] !== undefined) fields[f] = o[f];
    byId.set(o.id, fields);
  }
  const result = accounts.map((a) => {
    const fields = a && byId.get(a.id);
    if (!fields) return a;
    const out = { ...a };
    for (const [f, v] of Object.entries(fields)) {
      if (v === null) delete out[f];
      else out[f] = v;
    }
    return out;
  });
  overlayMemo = { accounts, key, result };
  return result;
}

/**
 * The data a simulation walks, with unsaved account edits over it: `data`
 * itself without any, else a copy whose accounts are the overlay
 * (`accountsWithOverrides`, memoised, so the walk's cache keeps hitting).
 * `accounts` is the overlaid array either way.
 *
 * @param {any} data  the snapshot
 * @param {AccountOverride[] | undefined} overrides
 * @returns {{ source: any, accounts: any[] }}
 */
export function withAccountOverrides(data, overrides) {
  const accounts = accountsWithOverrides(data.accounts || NONE, overrides);
  return { source: accounts === data.accounts ? data : { ...data, accounts }, accounts };
}

/** @type {{ raw: unknown, accounts: any, budgetItems: any, result: import('../engine/whatif.js').WhatIfScenario[] } | null} */
let scenarioMemo = null;

/**
 * `normalizeScenarios`, memoised one slot on the identity of its three
 * inputs: the same `raw` + `accounts` + `budgetItems` return the same array
 * with the same scenario objects, the identity `simulate` caches on.
 *
 * @param {unknown} raw  `meta.whatIfScenarios`, as stored
 * @param {any[]} accounts  the stored accounts
 * @param {any[]} budgetItems
 * @returns {import('../engine/whatif.js').WhatIfScenario[]}
 */
export function whatIfScenarios(raw, accounts, budgetItems) {
  if (scenarioMemo && scenarioMemo.raw === raw && scenarioMemo.accounts === accounts && scenarioMemo.budgetItems === budgetItems) {
    return scenarioMemo.result;
  }
  const result = normalizeScenarios(raw, { accounts, budgetItems });
  scenarioMemo = { raw, accounts, budgetItems, result };
  return result;
}
