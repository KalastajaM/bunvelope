// js/engine/loan-schedule.js — a loan's repayment schedule: every payment
// its plan item still has to make, from what is owed today to zero.
//
// Each payment is split exactly as posting and the forecast split it
// (`loanOccurrenceSplit`, by the item's `loan_method`), so the schedule is
// what the app will actually book, month by month, if nothing changes: the
// loan's interest day count over the days since the previous payment, the
// rate in effect on each day (rates entered for later dates apply
// from their date, the latest one holds after that), the item's own calendar
// (`payment_day`, skipped months, `as_schedule_until`), and the item's other
// costs. Extra repayments and rate changes nobody has entered yet are, by
// definition, not in it.
//
// Pure. No DOM, no I/O, no clock: `today` is a parameter.

import { computeScheduledOccurrences, loanOccurrenceSplit, loanOwedAt } from './scheduling.js';
import { loanMethod } from './loan-terms.js';
import { requireClock, CENT_EPSILON, MONTH_NAMES } from './_constants.js';
import { round2 } from '../utils.js';

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ymd = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** How far ahead a schedule looks before it gives up on a payoff. */
export const LOAN_SCHEDULE_MAX_YEARS = 60;

/**
 * @typedef {{
 *   date: string, monthKey: string,
 *   payment: number, interest: number, fee: number, principal: number,
 *   owedAfter: number,
 * }} LoanScheduleRow
 *
 * @typedef {{
 *   method: 'fixed_payment' | 'annuity' | 'equal_principal',
 *   owedNow: number,
 *   rows: LoanScheduleRow[],
 *   payoffDate: string | null,
 *   totalInterest: number,
 *   totalFees: number,
 *   owedAtEnd: number,
 *   ends: 'repaid' | 'plan_ends' | 'not_repaid' | 'no_payments',
 * }} LoanSchedule
 */

/**
 * The repayment schedule of a `loan_payment` plan item on its loan account.
 *
 * Starts from what is owed on the loan at the end of `today` (every real row
 * up to then), with the item's first payment not yet posted: an occurrence
 * whose `from_budget` key is already on a row has been paid, and one dated
 * today or later that has not is still to come.
 *
 * `ends` says how it stops: 'repaid' (owed reaches zero, on `payoffDate`);
 * 'plan_ends' (the item stops, `as_schedule_until`, with `owedAtEnd` left);
 * 'not_repaid' (a fixed payment that does not cover the interest, or no
 * payoff within LOAN_SCHEDULE_MAX_YEARS); 'no_payments' (nothing owed, or
 * the item has no occurrence ahead).
 *
 * @param {object} input
 * @param {any} input.item  the `loan_payment` plan item
 * @param {any} input.loan  its loan account (`item.to_account_id`)
 * @param {any[]} [input.transactions]  real rows (forecast rows are ignored)
 * @param {Date} input.today
 * @param {string} [input.country]  for working-day payment dates
 * @returns {LoanSchedule}
 */
export function loanSchedule({ item, loan, transactions, today, country = 'FI' }) {
  const clock = requireClock(today, 'loanSchedule');
  const todayStr = ymd(clock);
  const txs = (transactions || []).filter(tx => tx && !tx.is_forecast);
  const owedNow = loanOwedAt(loan, txs, todayStr);
  /** @type {LoanSchedule} */
  const out = {
    method: loanMethod(item), owedNow, rows: [], payoffDate: null,
    totalInterest: 0, totalFees: 0, owedAtEnd: owedNow, ends: 'no_payments',
  };
  if (!(owedNow > 0) || !item || !loan) return out;

  const posted = new Set();
  for (const tx of txs) if (typeof tx.from_budget === 'string') posted.add(tx.from_budget);

  // From the start of this month: a payment due earlier this month that has
  // not been posted yet is still owed (the app posts it on the next open).
  const from = `${todayStr.slice(0, 7)}-01`;
  const end = new Date(clock.getFullYear() + LOAN_SCHEDULE_MAX_YEARS, clock.getMonth(), clock.getDate());
  const occurrences = computeScheduledOccurrences({ ...item, as_schedule: true }, from, ymd(end), {
    dayType: item.schedule_day_type, country,
  });

  let owed = owedNow;
  let interest = 0;
  let fees = 0;
  /** @type {string | null} */
  let prevDate = null;
  for (const occ of occurrences) {
    const fromDate = prevDate;
    prevDate = occ.date;
    if (posted.has(`${item.id}:${occ.monthKey}`)) continue;
    const split = loanOccurrenceSplit(item, loan, occ, owed, { prevDate: fromDate, country });
    if (split.principal < CENT_EPSILON) {
      // A fixed payment that only covers the interest (or less): the loan
      // never shrinks, so there is no payoff to show.
      out.ends = 'not_repaid';
      break;
    }
    owed = round2(owed - split.principal);
    interest = round2(interest + split.interest);
    fees = round2(fees + split.fee);
    out.rows.push({
      date: occ.date, monthKey: occ.monthKey,
      payment: round2(split.principal + split.interest + split.fee),
      interest: split.interest, fee: split.fee, principal: split.principal,
      owedAfter: owed,
    });
    if (owed < CENT_EPSILON) {
      out.ends = 'repaid';
      out.payoffDate = occ.date;
      break;
    }
  }
  out.totalInterest = interest;
  out.totalFees = fees;
  out.owedAtEnd = owed < CENT_EPSILON ? 0 : owed;
  if (out.ends === 'no_payments' && out.rows.length) {
    // Ran out of payments with money still owed: the item stops first
    // (as_schedule_until), or no payoff within the horizon.
    const until = typeof item.as_schedule_until === 'string' ? item.as_schedule_until.slice(0, 10) : '';
    out.ends = until && until < ymd(end) ? 'plan_ends' : 'not_repaid';
  }
  return out;
}

/**
 * @typedef {{ status: 'none' } | { status: 'shared', count: number }
 *   | { status: 'ok', item: any, schedule: LoanSchedule }} LoanRepayment
 */

/**
 * How a loan account is being repaid: by the one enabled, scheduled plan item
 * that pays it ('ok', with its schedule), by none, or by more than one
 * ('shared': which payment is which is the user's to say, so no schedule).
 *
 * @param {any} account  a `loan` account
 * @param {{ budgetItems?: any[], transactions?: any[], today: Date, country?: string }} ctx
 * @returns {LoanRepayment}
 */
export function loanRepayment(account, { budgetItems, transactions, today, country = 'FI' }) {
  const items = (budgetItems || []).filter(it => it && it.kind === 'loan_payment' && it.as_schedule
    && it.include !== false && it.to_account_id === account.id);
  if (items.length === 0) return { status: 'none' };
  if (items.length > 1) return { status: 'shared', count: items.length };
  const item = items[0];
  return { status: 'ok', item, schedule: loanSchedule({ item, loan: account, transactions, today, country }) };
}

/**
 * A loan account's balance (negative: owed) at the end of each calendar
 * month by its schedule: index 0 is the end of `today`'s month, index k the
 * end of the month k later, `months` + 1 entries. The month a payment falls
 * in carries what it leaves; after the last payment the balance holds (zero
 * once repaid). The same month ends `simulate` snapshots (`monthly`), so the
 * Net worth projection can take a loan's line from it past the simulated
 * years.
 *
 * @param {LoanSchedule} schedule
 * @param {Date} today
 * @param {number} months
 * @returns {number[]}
 */
export function loanBalancePath(schedule, today, months) {
  const clock = requireClock(today, 'loanBalancePath');
  const out = [];
  let owed = schedule.owedNow;
  let i = 0;
  for (let k = 0; k <= months; k++) {
    const d = new Date(clock.getFullYear(), clock.getMonth() + k, 1);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    while (i < schedule.rows.length && schedule.rows[i].monthKey <= key) owed = schedule.rows[i++].owedAfter;
    out.push(owed > 0 ? -owed : 0);
  }
  return out;
}

/**
 * What a loan's plan item should say now, so plan figures (totals, fill %,
 * Stress, Review, template fills, the Budget project) stop counting a loan
 * once it is paid off. Owner decision 2026-10-02: applied automatically when
 * the budget opens. Pure: returns the changed items; the caller saves them.
 *
 * For each enabled, scheduled `loan_payment` item:
 *   • repaid (nothing owed, and money was paid into the loan): disabled
 *     (`include: false`) with `loan_paid_off` (the last payment's date). An
 *     item re-enabled by hand after that is left alone until the loan is
 *     owed on again, which clears the mark.
 *   • paid off within the next 12 months: the calendar months after the
 *     payoff month, up to a year from now, are switched off, so this year's
 *     plan stops at the payoff. Their previous values are kept in
 *     `loan_months_off` and put back before every check, so a payoff that
 *     moves later (a rate rise) turns them on again.
 *   • an annuity or equal principal: `default_amount` follows the next
 *     payment (the plan's figure for the month).
 *
 * @param {{ budgetItems: any[], accounts: any[], transactions: any[], today: Date, country?: string }} input
 * @returns {Array<{ item: any, reason: 'repaid' | 'plan' }>}
 */
export function loanPlanUpdates({ budgetItems, accounts, transactions, today, country = 'FI' }) {
  const clock = requireClock(today, 'loanPlanUpdates');
  const todayStr = ymd(clock);
  const txs = (transactions || []).filter(tx => tx && !tx.is_forecast);
  const acctById = new Map((accounts || []).filter(a => a && a.id).map(a => [a.id, a]));
  /** @type {Array<{ item: any, reason: 'repaid' | 'plan' }>} */
  const out = [];
  for (const item of budgetItems || []) {
    if (!item || item.kind !== 'loan_payment' || !item.as_schedule) continue;
    const loan = acctById.get(item.to_account_id);
    if (!loan) continue;

    // Start from the item as the user left it: the months a previous check
    // switched off are back on, and the schedule decides again.
    const kept = item.loan_months_off && typeof item.loan_months_off === 'object' ? item.loan_months_off : {};
    const sched = { ...(item.monthly_schedule || {}) };
    // A month the editor saved as off has no key at all; either way it is off.
    for (const m of MONTH_NAMES) if (Object.hasOwn(kept, m) && !sched[m]) sched[m] = kept[m];
    /** @type {any} */
    let next = { ...item, monthly_schedule: sched };
    delete next.loan_months_off;

    const owedNow = loanOwedAt(loan, txs, todayStr);
    const payments = txs.filter(tx => tx.type === 'debt_payment' && tx.to_account === loan.id && String(tx.date).slice(0, 10) <= todayStr);
    let reason = /** @type {'repaid' | 'plan'} */ ('plan');
    if (owedNow > 0) {
      delete next.loan_paid_off;
      if (next.include !== false) {
        const s = loanSchedule({ item: next, loan, transactions: txs, today: clock, country });
        if (loanMethod(next) !== 'fixed_payment' && s.rows.length) {
          const pay = s.rows[0].payment;
          if (Math.abs(Math.abs(Number(next.default_amount) || 0) - pay) >= CENT_EPSILON) next.default_amount = -pay;
        }
        if (s.ends === 'repaid' && s.payoffDate) {
          const off = {};
          const [py, pm] = s.payoffDate.split('-').map(Number);
          const payoffIdx = py * 12 + pm - 1;
          const lastIdx = clock.getFullYear() * 12 + clock.getMonth() + 11;
          for (let k = payoffIdx + 1; k <= lastIdx; k++) {
            const m = MONTH_NAMES[k % 12];
            const v = next.monthly_schedule[m];
            if (v !== undefined && v !== false && v !== 0) off[m] = v;
          }
          if (Object.keys(off).length) {
            next.monthly_schedule = { ...next.monthly_schedule, ...Object.fromEntries(Object.keys(off).map(m => [m, false])) };
            next.loan_months_off = off;
          }
        }
      }
    } else if (payments.length && item.include !== false && !item.loan_paid_off) {
      next.include = false;
      next.loan_paid_off = payments.map(tx => String(tx.date).slice(0, 10)).sort().at(-1);
      reason = 'repaid';
    }

    const keys = ['include', 'default_amount', 'monthly_schedule', 'loan_months_off', 'loan_paid_off'];
    const same = keys.every(k => JSON.stringify(next[k]) === JSON.stringify(item[k]));
    if (!same) out.push({ item: next, reason });
  }
  return out;
}
