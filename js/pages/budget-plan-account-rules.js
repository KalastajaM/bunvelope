// js/pages/budget-plan-account-rules.js — account-field rules for the plan
// item editor sheet.
//
// Pure and DOM-free (budget-plan-shared.js imports app.js, which needs a DOM
// at import time), so the editor's account picker and its save path share one
// tested rule instead of each re-deriving it.

/**
 * Whether the account picker should be interactive for a plan item's kind
 * and current scheduling state.
 *
 * An expense item may name the account it charges whether or not it posts on
 * a schedule — unscheduled, the account is a forecast hint, not a posting
 * target. Every other kind (income, investment_transfer, account_transfer)
 * keeps today's rule: the picker only matters, and is only enabled, while
 * "Post as scheduled" is on.
 * @param {string} kind
 * @param {boolean} asSchedule
 * @returns {boolean}
 */
export function isAccountPickerEnabled(kind, asSchedule) {
  return kind === 'expense' || asSchedule;
}

/**
 * What the account picker's empty option means, as an i18n key.
 *
 * Only an unscheduled expense-type item is forecast from its envelope's
 * history when no account is named, so only there does empty read "from
 * history". A scheduled item posts on the account it names and posts nothing
 * without one, and income and transfers never read history: for those the
 * empty option is simply "choose an account".
 * @param {string} kind
 * @param {boolean} asSchedule
 * @returns {'budgetPlan.accountFromHistory'|'budgetPlan.chooseAccount'}
 */
export function accountEmptyLabelKey(kind, asSchedule) {
  const expenseLike = kind !== 'income' && kind !== 'investment_transfer' && kind !== 'account_transfer';
  return expenseLike && !asSchedule ? 'budgetPlan.accountFromHistory' : 'budgetPlan.chooseAccount';
}

// `resolvePlanItemAccountId` moved to js/core/plan-item-rules.js, where the
// plan-item commands share it; re-exported for the editor.
export { resolvePlanItemAccountId } from '../core/plan-item-rules.js';
