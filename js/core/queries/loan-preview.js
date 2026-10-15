// js/core/queries/loan-preview.js — the plan editor's loan summary: the
// repayment schedule of a loan payment as the form stands, before it is saved.
//
// The item is a draft, so it comes as input, typed field by field: the fields
// the schedule reads (the payment, its method and end month, the fee, the
// calendar, and the stored item's own dates and legacy rate). An unsaved item
// has no id; then no occurrence of it has been paid. The loan is the account
// it pays. The schedule starts from what is owed on the loan at the end of
// `date` over the stored rows (loanSchedule), and the answer is what the
// editor reads off it:
//
//   firstPayment  the first payment still to make (a calculated method's
//                 amount), or null without one
//   ends          repaid | plan_ends | not_repaid | no_payments
//   payoffDate    the day it is repaid, or null
//   totalInterest the interest until then (or until the schedule stops)
//   owedAtEnd     what is still owed when the schedule stops
//   owedNow       what is owed on `date`
//   lastMonth     the last payment's month (YYYY-MM), or null
//
// Money is round2'd on output.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { monthCountry } from '../month-fields.js';
import { ITEM_FIELD_PROPERTIES } from '../entity-fields.js';
import { STORED_MONTHLY_SCHEDULE } from '../item-overrides.js';
import { loanSchedule } from '../../engine/loan-schedule.js';
import { LOAN_METHODS } from '../../engine/loan-terms.js';
import { round2 } from '../../utils.js';

/** The draft loan payment's fields the schedule reads. */
const DRAFT_PROPERTIES = Object.freeze({
  id: { type: 'string', description: 'The plan item\'s id; none for an item not yet saved (no payment of it has been made)' },
  default_amount: ITEM_FIELD_PROPERTIES.default_amount,
  loan_fee: ITEM_FIELD_PROPERTIES.loan_fee,
  loan_method: { enum: [...LOAN_METHODS], nullable: true, description: 'fixed_payment (or none) = the amount is the payment; annuity and equal_principal need loan_end' },
  loan_end: ITEM_FIELD_PROPERTIES.loan_end,
  loan_rate: { anyOf: [{ type: 'number' }, { type: 'string' }], nullable: true, description: 'Legacy yearly %: used when the loan account has no rate' },
  // Any whole number: the calendar clamps a day past the month's end.
  payment_day: { type: 'integer', description: 'Day of the month the payment is due' },
  schedule_day_type: ITEM_FIELD_PROPERTIES.schedule_day_type,
  monthly_schedule: STORED_MONTHLY_SCHEDULE,
  as_schedule_since: { type: 'string', nullable: true, description: 'First day it posts on (YYYY-MM-DD)' },
  as_schedule_until: { type: 'string', nullable: true, description: 'Legacy last day it posts on (YYYY-MM-DD)' },
  start_month: ITEM_FIELD_PROPERTIES.start_month,
  end_month: ITEM_FIELD_PROPERTIES.end_month,
  skipped_occurrences: { type: 'array', items: { type: 'string' }, description: 'Months skipped (YYYY-MM)' },
});

export default {
  name: 'loan.preview',
  summary: 'A loan payment\'s repayment schedule before it is saved, as the plan editor previews it: the item\'s fields as the form stands (an unsaved item has no id) on the loan account it pays, from what is owed on date: firstPayment (the first payment still to make, the amount a calculated method sets), ends (repaid, plan_ends, not_repaid or no_payments), payoffDate, totalInterest, owedAtEnd (owed when the schedule stops), owedNow and lastMonth (the last payment\'s month).',
  input: {
    type: 'object',
    required: ['item', 'loan'],
    properties: {
      item: { type: 'object', description: 'The loan payment as the form stands', properties: DRAFT_PROPERTIES },
      loan: { type: 'ref', kind: 'account', description: 'The loan account it pays' },
      date: { type: 'date', description: 'Today for the schedule: what is owed at its end, and the payments from its month on (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ item: Record<string, any>, loan: string, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const loan = (data.accounts || []).find((/** @type {any} */ a) => a && a.id === input.loan);
    const s = loanSchedule({
      item: { ...input.item, kind: 'loan_payment', to_account_id: input.loan, as_schedule: true },
      loan,
      transactions: data.transactions || [],
      today: refDate(input, ctx),
      country: monthCountry(data),
    });
    const last = s.rows.length ? s.rows[s.rows.length - 1] : null;
    return ok({
      firstPayment: s.rows.length ? round2(s.rows[0].payment) : null,
      ends: s.ends,
      payoffDate: s.payoffDate,
      totalInterest: round2(s.totalInterest),
      owedAtEnd: round2(s.owedAtEnd),
      owedNow: round2(s.owedNow),
      lastMonth: last ? last.monthKey : null,
    });
  },
};
