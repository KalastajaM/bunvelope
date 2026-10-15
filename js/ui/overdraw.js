// js/ui/overdraw.js — does an entry overdraw the cash account that pays it?
//
// The add form asks the `balances` query before the save and of the budget as
// it would be after it (`session.queryAfter`, a dry run of the very steps it
// will commit), and warns when the paying account crosses from zero or more to
// below zero, as it already does for the unallocated figure. Only the
// answers' figures are compared: no money is computed here.

/** Accounts a payment can overdraw. A card, a loan or an investment account
 *  is negative or moves by design, so it is never warned about. */
const OVERDRAWABLE_TYPES = new Set(['bank', 'cash', 'savings']);

/**
 * The paying account's balance after the entry, when the entry takes it below
 * zero from zero or more; otherwise null. Already negative before is not
 * re-confirmed on each entry, matching the unallocated warning.
 *
 * @param {{ accounts?: Array<{ id: string, name?: string|null, type?: string|null, balance: number }> } | null | undefined} before
 * @param {{ accounts?: Array<{ id: string, name?: string|null, type?: string|null, balance: number }> } | null | undefined} after
 * @param {string | null | undefined} accountId
 * @returns {{ id: string, name: string, balance: number } | null}
 */
export function overdrawnAccount(before, after, accountId) {
  if (!accountId) return null;
  const was = before?.accounts?.find(a => a.id === accountId);
  const now = after?.accounts?.find(a => a.id === accountId);
  if (!was || !now || !OVERDRAWABLE_TYPES.has(now.type || '')) return null;
  if (!(was.balance >= -0.005 && now.balance < -0.005)) return null;
  return { id: now.id, name: now.name || '', balance: now.balance };
}
