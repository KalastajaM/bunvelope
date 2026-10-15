// js/engine/loan-terms.js — a loan's interest: its rate over time, and a
// loan given's interest cycle.
//
// Rates: a loan account (`loan`) or a loan given (`loan_given`) carries
// `interestRates`, a dated list `[{ from: 'YYYY-MM-DD', rate: <% per year> }]`.
// A fixed rate is one entry; a Euribor-linked loan gets a new entry each time
// the rate resets (the user enters Euribor + margin; nothing is fetched). The
// rate in effect on a day is the latest entry dated on or before it.
// Accounts set up before the list existed may still carry savings-style
// `interestTiers`; their single rate is read as a rate in effect throughout.
//
// A loan given's terms (owner decisions 2026-10-01/02): `loanStart` and
// `loanEnd` (YYYY-MM-DD, optional) and `interestPayout` ('monthly' |
// 'quarterly' | 'yearly', default yearly). Interest accrues day by day on
// what is still owed, at the rate in effect that day; it falls due every
// period counted from the start date (yearly from 1 Mar 2026: 1 Mar 2027,
// 1 Mar 2028, …), the last cycle cut short by the end date; and it is paid
// in CASH, booked as income when it arrives, so it never changes the loan's
// balance. An income row carrying `interest_of: <loan given id>` is interest
// received on it, and what is outstanding is net of it. Without a rate or a
// start date there is no cycle.
//
// Pure functions. No DOM, no I/O, no clock: `today` is a parameter.

import { txAccountDelta } from './tx-amounts.js';
import { requireClock } from './_constants.js';
import { round2, validateAmount } from '../utils.js';

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ymd = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** @param {any} v @returns {string | null} */
function isoDay(v) {
  return typeof v === 'string' && ISO_DAY.test(v) ? v : null;
}

/** @param {string} iso */
function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The same day-of-month `months` later, clamped to the month's length. @param {string} iso @param {number} months */
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = idx % 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

/**
 * The account's dated rates, valid entries only, oldest first.
 * @param {any} account
 * @returns {Array<{ from: string, rate: number }>}
 */
export function loanRates(account) {
  const list = Array.isArray(account?.interestRates) ? account.interestRates : [];
  return list
    .filter(r => r && isoDay(r.from) && Number.isFinite(Number(r.rate)) && Number(r.rate) >= 0)
    .map(r => ({ from: r.from, rate: Number(r.rate) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/**
 * The yearly rate (%) in effect on `dayStr`, or null when none applies yet.
 * Falls back to the single rate of legacy `interestTiers`.
 *
 * @param {any} account
 * @param {string} dayStr  YYYY-MM-DD
 * @returns {number | null}
 */
export function loanRateOn(account, dayStr) {
  const rates = loanRates(account);
  if (rates.length) {
    let rate = null;
    for (const r of rates) { if (r.from > dayStr) break; rate = r.rate; }
    return rate;
  }
  const tier = Array.isArray(account?.interestTiers) ? account.interestTiers.find(t => t && Number.isFinite(Number(t.rate))) : null;
  return tier ? Number(tier.rate) : null;
}

// ── Repayment methods (a `loan_payment` plan item) ──────────────────────────
//
// `loan_method` on the item, owner decision 2026-10-02 (several loans,
// mixed methods):
//   • 'fixed_payment' (default): the item's amount is the payment; interest
//     comes out of it first and the rest pays the loan down, so a rate change
//     moves the end date (kiinteä tasaerä). Every item before the field existed.
//   • 'annuity': the payment is recalculated each month from what is owed,
//     the rate and the months left to `loan_end`, so the loan ends on time
//     whatever the rate does (annuiteetti).
//   • 'equal_principal': what is owed ÷ the months left, plus that month's
//     interest, so the payment falls over time (tasalyhennys).
// The two calculated methods need `loan_end` ('YYYY-MM', the month of the
// last payment); without one an item is read as a fixed payment. The item's
// other costs (`loan_fee`) come out of a fixed payment and on top of a
// calculated one. Interest is owed × rate ÷ 12, the plan's estimate rather
// than the bank's day count. Recalculating every month is what keeps the end
// date after a rate change or an extra repayment; with neither, the payment
// it gives is the bank's constant one.

export const LOAN_METHODS = Object.freeze(['fixed_payment', 'annuity', 'equal_principal']);

// ── Interest day count (a `loan` account's `interestDayCount`) ──────────────
//
// Owner decision 2026-10-02: interest is charged for the days since the
// previous payment, at the rate in effect on each of those days, so a rate
// reset mid-month counts from its date:
//   • 'act/365' (default, Finnish housing loans): owed × Σ rate ÷ 365;
//   • 'act/360' (some Euribor-linked loans): ÷ 360, slightly more;
//   • '30/360': a flat month, owed × rate ÷ 12 at the payment day's rate,
//     what the app charged before the setting existed.
// "Owed" is the balance before the payment; an extra repayment inside the
// period counts from the period's start, a small overstatement of the saving.

export const LOAN_DAY_COUNTS = Object.freeze(['act/365', 'act/360', '30/360']);

/** The loan's day count, 'act/365' unless it says otherwise. @param {any} loan */
export function loanDayCount(loan) {
  const v = loan?.interestDayCount;
  return v === 'act/360' || v === '30/360' ? v : 'act/365';
}

/**
 * Interest on `owed` for the days from `fromStr` (included) to `toStr` (the
 * payment day, excluded), at `rateOn(day)` % a year on each day.
 *
 * @param {{ owed: number, fromStr: string, toStr: string,
 *   dayCount: 'act/365' | 'act/360' | '30/360', rateOn: (day: string) => number | null }} p
 * @returns {number}
 */
export function loanPeriodInterest({ owed, fromStr, toStr, dayCount, rateOn }) {
  if (!(owed > 0)) return 0;
  if (dayCount === '30/360') return round2(owed * (rateOn(toStr) ?? 0) / 1200);
  const basis = dayCount === 'act/360' ? 360 : 365;
  let rateDays = 0;
  for (let d = toDate(fromStr); ymd(d) < toStr; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    rateDays += rateOn(ymd(d)) ?? 0;
  }
  return round2(owed * rateDays / 100 / basis);
}
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The repayment method an item is actually paid by: a calculated method only
 * with a valid `loan_end`.
 * @param {any} item
 * @returns {'fixed_payment' | 'annuity' | 'equal_principal'}
 */
export function loanMethod(item) {
  const m = item?.loan_method;
  if ((m === 'annuity' || m === 'equal_principal') && typeof item.loan_end === 'string' && YM.test(item.loan_end)) return m;
  return 'fixed_payment';
}

/**
 * Payments left from `monthKey` to `endYm`, both included (1 in the last
 * month, 0 or less after it).
 * @param {string} endYm  'YYYY-MM'
 * @param {string} monthKey  'YYYY-MM'
 */
export function loanMonthsLeft(endYm, monthKey) {
  const idx = (/** @type {string} */ ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  return idx(endYm) - idx(monthKey) + 1;
}

/**
 * One payment's split by the item's method: its other costs, the interest on
 * what is owed, and the principal, capped at what is owed. A repaid loan
 * pays nothing.
 *
 * @param {any} item  the `loan_payment` plan item
 * @param {{ amount: number, owed: number, rate: number | null, monthKey: string, interest?: number }} occ
 *   amount: the plan's payment that month (a fixed payment's whole payment;
 *   ignored by the calculated methods), owed: before this payment,
 *   rate: yearly % in effect that day, monthKey: the payment's month,
 *   interest: the period's interest by the loan's day count
 *   (`loanPeriodInterest`); without it, owed × rate ÷ 12. An annuity's
 *   payment is still sized at rate ÷ 12, as banks size it.
 * @returns {{ interest: number, fee: number, principal: number }}
 */
export function loanInstalment(item, { amount, owed, rate, monthKey, interest: periodInterest }) {
  if (!(owed > 0)) return { interest: 0, fee: 0, principal: 0 };
  const i = rate && rate > 0 ? rate / 1200 : 0;
  const owedInterest = Number.isFinite(periodInterest) ? /** @type {number} */ (periodInterest) : (i > 0 ? round2(owed * i) : 0);
  const feeSet = Math.max(0, validateAmount(item?.loan_fee) ?? 0);
  const method = loanMethod(item);
  if (method === 'fixed_payment') {
    const pay = Math.abs(Number(amount) || 0);
    const fee = Math.min(pay, feeSet);
    const interest = Math.min(round2(pay - fee), owedInterest);
    const principal = Math.min(round2(pay - fee - interest), owed);
    return { interest, fee, principal: Math.max(0, principal) };
  }
  const n = loanMonthsLeft(item.loan_end, monthKey);
  const interest = owedInterest;
  let principal;
  if (n <= 1) {
    // The last payment, or one after the end date: whatever is still owed.
    principal = owed;
  } else if (method === 'annuity') {
    const payment = round2(i > 0 ? owed * i / (1 - Math.pow(1 + i, -n)) : owed / n);
    principal = round2(payment - interest);
  } else {
    principal = round2(owed / n);
  }
  return { interest, fee: feeSet, principal: round2(Math.min(owed, Math.max(0, principal))) };
}

/** Whether the account has any interest rate at all. @param {any} account */
function hasRate(account) {
  return loanRates(account).length > 0
    || (Array.isArray(account?.interestTiers) && account.interestTiers.some(t => t && Number(t.rate) > 0));
}

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * @typedef {{
 *   start: string | null, end: string | null,
 *   cycleStart: string | null, dueDate: string | null,
 *   owed: number, accrued: number, atDue: number, received: number,
 * }} LoanGivenTerms
 */

/**
 * Interest received on a loan given: the income rows linked to it by
 * `interest_of`, not forecast, dated from the loan's start (any date without
 * one) through `todayStr`.
 *
 * @param {string} accountId
 * @param {any[]} transactions
 * @param {string | null} start
 * @param {string} todayStr
 * @returns {number}
 */
function interestReceived(accountId, transactions, start, todayStr) {
  let received = 0;
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast || tx.type !== 'income' || tx.interest_of !== accountId) continue;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    if (!d || d > todayStr || (start && d < start)) continue;
    received += Math.abs(validateAmount(tx.amount) ?? 0);
  }
  return received;
}

/**
 * Where a loan given stands on `today`: what is owed, the current interest
 * cycle and its due date, and the interest still outstanding, now
 * (`accrued`) and on the due date if nothing more is repaid and the rate
 * holds (`atDue`). Outstanding (owner decision 2026-10-05) is every day's
 * interest since the start, less the interest received (`received`: income
 * rows linked by `interest_of`), floored at zero; a cycle paid in full
 * leaves only the current cycle's interest, and one left unpaid carries
 * over. Null for any other account.
 *
 * @param {any} account
 * @param {any[]} transactions
 * @param {Date} today
 * @returns {LoanGivenTerms | null}
 */
export function loanGivenTerms(account, transactions, today) {
  if (!account || account.type !== 'loan_given') return null;
  const todayStr = ymd(requireClock(today, 'loanGivenTerms'));
  const start = isoDay(account.loanStart);
  const end = isoDay(account.loanEnd);

  // What is owed at the end of each day: the opening balance plus every
  // non-forecast row on the account dated that day or earlier.
  /** @type {Array<{ d: string, delta: number }>} */
  const moves = [];
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    if (!d) continue;
    const delta = txAccountDelta(tx, account.id);
    if (delta) moves.push({ d, delta });
  }
  moves.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const opening = Number(account.initialBalance) || 0;
  let owedToday = opening;
  for (const m of moves) { if (m.d > todayStr) break; owedToday += m.delta; }
  const owed = round2(Math.max(0, owedToday));
  const receivedRaw = interestReceived(account.id, transactions, start, todayStr);
  const received = round2(receivedRaw);

  if (!start || !hasRate(account)) {
    return { start, end, cycleStart: null, dueDate: null, owed, accrued: 0, atDue: 0, received };
  }

  const period = PERIOD_MONTHS[/** @type {'monthly' | 'quarterly' | 'yearly'} */ (account.interestPayout)] || 12;
  let k = 1;
  let dueDate = addMonths(start, period);
  while (dueDate < todayStr && k < 1200) { k++; dueDate = addMonths(start, k * period); }
  const cycleStart = k > 1 ? addMonths(start, (k - 1) * period) : start;
  if (end && dueDate > end) dueDate = end;

  const dailyOn = (/** @type {string} */ day, /** @type {number} */ amount) => {
    const rate = loanRateOn(account, day);
    return rate ? amount * rate / 100 / 365 : 0;
  };
  // Every day from the start, on what was owed at the end of that day: the
  // balance is carried forward move by move (the moves are sorted), so a
  // long loan walks its rows once.
  let bal = opening;
  let next = 0;
  let accruedTotal = 0;
  let atDueTotal = 0;
  for (let d = toDate(start); ymd(d) < dueDate; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const day = ymd(d);
    if (day < todayStr) {
      while (next < moves.length && moves[next].d <= day) bal += moves[next++].delta;
      const i = dailyOn(day, Math.max(0, bal));
      accruedTotal += i;
      atDueTotal += i;
    } else {
      // From today on: what is owed today, nothing more repaid.
      atDueTotal += dailyOn(day, owed);
    }
  }
  return {
    start, end, cycleStart, dueDate, owed,
    accrued: round2(Math.max(0, accruedTotal - receivedRaw)),
    atDue: round2(Math.max(0, atDueTotal - receivedRaw)),
    received,
  };
}
