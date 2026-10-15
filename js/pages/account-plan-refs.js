// js/pages/account-plan-refs.js — count budget-plan items that reference an
// account, for the account delete/archive warnings in account-edit.js.
// Pure; no DOM (and no import of app.js), so it is testable without the page.

/**
 * Number of plan items that POST to or from `accountId` — scheduled and not
 * Disabled (only an explicit `include: false` is Disabled) — and name it as
 * their own account
 * (`account_id`), a transfer's destination (`to_account_id`), or an
 * investment_transfer's investment side (`investment_account_id`). Counts
 * distinct items, not references — an item naming the account under more
 * than one field still counts once.
 * @param {any[]} budgetItems
 * @param {string} accountId
 * @returns {number}
 */
export function planItemsUsingAccount(budgetItems, accountId) {
  if (!accountId || !Array.isArray(budgetItems)) return 0;
  let n = 0;
  for (const item of budgetItems) {
    if (!item || !item.as_schedule || item.include === false) continue;
    if (item.account_id === accountId
      || item.to_account_id === accountId
      || item.investment_account_id === accountId) n++;
  }
  return n;
}

/**
 * Number of plan items that do NOT post but name `accountId` as the account
 * their forecast charges: unscheduled, not Disabled, `account_id` set. Once
 * the account is archived or deleted, `plannedExpenseRows` treats it as
 * absent and those forecasts quietly fall back to the envelope's history,
 * which the warnings should say rather than leave to be discovered.
 * @param {any[]} budgetItems
 * @param {string} accountId
 * @returns {number}
 */
export function plannedItemsForecastingFromAccount(budgetItems, accountId) {
  if (!accountId || !Array.isArray(budgetItems)) return 0;
  let n = 0;
  for (const item of budgetItems) {
    if (!item || item.as_schedule || item.include === false) continue;
    if (item.account_id === accountId) n++;
  }
  return n;
}
