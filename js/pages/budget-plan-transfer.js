// js/pages/budget-plan-transfer.js — pure helpers for the `account_transfer`
// plan-item kind.
//
// Split out of budget-plan.js (which imports app.js, and so needs a DOM at
// import time — see js/engine/stress.js for the same rationale) so this piece
// of display logic can be unit-tested directly.

// Row-dot colour for a transfer: neutral, deliberately not the income green
// and not run through categoryColor() (a transfer has no envelope category).
export const TRANSFER_ROW_COLOR = '#8e8e93';

/**
 * A transfer's display name on the plan list: its own description if it has
 * one, otherwise "<from account name> → <to account name>" built from
 * `accounts` by id. Falls back to the raw id when an account was deleted, and
 * to '?' when the id itself is missing, so a broken link still shows
 * something recognisable rather than a blank arrow.
 *
 * @param {{account_id?: string|null, to_account_id?: string|null}} item
 * @param {Array<{id: string, name?: string}>} accounts
 * @returns {string}
 */
export function transferRowName(item, accounts) {
  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const nameOf = (id) => (id ? (byId.get(id)?.name || id) : '?');
  return `${nameOf(item?.account_id)} → ${nameOf(item?.to_account_id)}`;
}
