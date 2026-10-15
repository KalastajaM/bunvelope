// js/core/queries/accounts-detail.js — the figures an account card shows, as
// the Accounts page and the Dashboard's favourite accounts read them.
//
//   currentBalance  through the Today lens, whatever the lens; the card's
//                   "upcoming" hint is budgetBalance − currentBalance
//   budgetBalance   through the lens (the balance view)
//   portfolioValue  stored holdings valued at current prices (cost fallback),
//                   0 for empty tracked investments, null when not tracked
//   rate            a loan's or a loan given's yearly rate (%) in effect on
//                   `date` (its dated rates, else its legacy tiers' rate), or
//                   null: no rate, or not a loan
//   estInterest     the yearly interest its tiers give on the Today balance,
//                   0 without tiers or with nothing in it
//   loanTerms       a loan given's terms on `date` (what is owed, the current
//                   interest cycle, the interest outstanding now and at its
//                   end, net of the interest received), or null
//   repayment       a loan's repayment by its plan item on `date`: 'none',
//                   'shared' (more than one item pays it) with the count, or
//                   'ok' with the item's id and description and its schedule
//                   (every payment to the payoff, the payoff date, the totals,
//                   how it ends); null for any other account
//
// Terms and repayment read the stored rows, as the pages did: they walk the
// account's own history and the plan, so the lens's generated rows would
// count twice. For the accounts named, archived ones included, else every
// account, in account order.

import { ok } from '../result.js';
import { portfolioByAccount } from '../portfolio.js';
import { LENS_INPUT, lensRows, refDate, todayRows } from '../lens-input.js';
import { isoDate } from '../context.js';
import { monthCountry } from '../month-fields.js';
import { computeAccountBalances } from '../../engine/balances.js';
import { computeAnnualInterest } from '../../engine/tx-amounts.js';
import { loanRateOn, loanGivenTerms } from '../../engine/loan-terms.js';
import { loanRepayment } from '../../engine/loan-schedule.js';
import { round2 } from '../../utils.js';

/**
 * The engine's LoanRepayment, JSON-safe: the plan item cut to its id and
 * description, money rounded to cents.
 * @param {import('../../engine/loan-schedule.js').LoanRepayment} r
 */
function repaymentAnswer(r) {
  if (r.status !== 'ok') return r.status === 'shared' ? { status: 'shared', count: r.count } : { status: 'none' };
  const s = r.schedule;
  return {
    status: 'ok',
    item: { id: r.item.id, description: r.item.description ?? null },
    schedule: {
      method: s.method,
      owedNow: round2(s.owedNow),
      rows: s.rows.map(row => ({
        date: row.date, monthKey: row.monthKey,
        payment: round2(row.payment), interest: round2(row.interest), fee: round2(row.fee),
        principal: round2(row.principal), owedAfter: round2(row.owedAfter),
      })),
      payoffDate: s.payoffDate,
      totalInterest: round2(s.totalInterest),
      totalFees: round2(s.totalFees),
      owedAtEnd: round2(s.owedAtEnd),
      ends: s.ends,
    },
  };
}

/** @typedef {ReturnType<typeof repaymentAnswer>} RepaymentAnswer */

export default {
  name: 'accounts.detail',
  summary: 'Per account, what its card shows: currentBalance (Today lens), budgetBalance (through the lens), portfolioValue (stored holdings at current prices with cost fallback, independent of lens/date; 0 for empty tracked investments, null when not tracked), rate (a loan\'s or loan given\'s yearly rate in % on date, else null), estInterest (the yearly interest its tiers give on the Today balance, 0 when none), loanTerms (a loan given\'s terms on date: start, end, the current cycle, its due date, what is owed, accrued and atDue: the interest outstanding now and at the cycle\'s due date (every day\'s interest since the start less what was received), and received: income linked to it by interestOf; else null) and repayment (a loan\'s repayment by its plan item: none, shared with the count, or ok with the item\'s id and description and every payment to the payoff; else null, and null for a loan too with repayment false). For the accounts named, archived ones included, else every account, in account order.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      date: { type: 'date', description: 'The day of the rate, the loan terms and the repayment schedule (YYYY-MM-DD, default today); the balances and estInterest stay at the query clock' },
      repayment: { type: 'boolean', default: true, description: 'false skips building a loan\'s repayment schedule: repayment is then null (default true)' },
      accounts: { type: 'array', items: { type: 'ref', kind: 'account' }, description: 'The account ids to report, archived ones included (default every account)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, date?: string, accounts?: string[], repayment?: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const { lens, horizon, txs } = rows.value;
    const ref = refDate(input, ctx);
    const day = isoDate(ref);
    const country = monthCountry(data);
    const stored = data.transactions || [];
    const wanted = input.accounts ? new Set(input.accounts) : null;
    const selected = (data.accounts || []).filter((/** @type {any} */ a) => !wanted || wanted.has(a.id));

    const portfolio = portfolioByAccount(data, selected);
    const budget = computeAccountBalances(data.accounts || [], txs);
    const current = computeAccountBalances(data.accounts || [], todayRows(data, ctx));

    return ok({
      lens,
      horizon,
      accounts: selected.map((/** @type {any} */ a) => {
        const currentBalance = round2(current.get(a.id) ?? 0);
        const isLoan = a.type === 'loan' || a.type === 'loan_given';
        const tiers = a.interestTiers;
        return {
          id: a.id,
          currentBalance,
          portfolioValue: portfolio.has(a.id) ? round2(portfolio.get(a.id)) : null,
          budgetBalance: round2(budget.get(a.id) ?? 0),
          rate: isLoan ? loanRateOn(a, day) : null,
          estInterest: Array.isArray(tiers) && tiers.length && currentBalance > 0 ? computeAnnualInterest(currentBalance, tiers, a.interestTierMode) : 0,
          loanTerms: a.type === 'loan_given' ? loanGivenTerms(a, stored, ref) : null,
          repayment: a.type === 'loan' && input.repayment !== false
            ? repaymentAnswer(loanRepayment(a, { budgetItems: data.budgetItems || [], transactions: stored, today: ref, country }))
            : null,
        };
      }),
    });
  },
};
