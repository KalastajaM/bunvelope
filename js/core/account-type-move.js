// js/core/account-type-move.js — the pure half of changing an account's type
// across the budget's cash boundary without moving Unallocated. The dialog
// that asks where the balance goes stays in js/pages/account-type-move.js.
//
// Accounts either count toward the zero-sum identity (Σ accounts = Σ
// envelopes + Unallocated) or sit outside it (investment, asset, loan and
// loan-given accounts; engine `countsTowardIdentity`). Switching a type
// across that line takes the account's balance out of the budget's cash, or
// brings it in, so Unallocated jumps by the whole balance. Typically the
// money was held in an envelope (a "Loans to others" savings account whose
// balance an envelope covered): the honest fix is to release that envelope
// by the same amount, as one envelope adjustment. Choosing "Unallocated"
// leaves the jump where it lands.

import { computeAccountBalances, countsTowardIdentity } from '../engine/balances.js';

/**
 * What a type change does to the budget's cash: null when it does not cross
 * the identity boundary or the balance is zero; otherwise the balance and
 * whether it leaves (`leaving: true`) or joins the budget's cash.
 *
 * @param {any} account   the account as stored
 * @param {string} newType
 * @param {any[]} accounts
 * @param {any[]} transactions
 * @returns {{ balance: number, leaving: boolean } | null}
 */
export function identityMove(account, newType, accounts, transactions) {
  if (!account || account.type === newType) return null;
  const before = countsTowardIdentity(account);
  const after = countsTowardIdentity({ ...account, type: newType });
  if (before === after) return null;
  const balance = computeAccountBalances(accounts, transactions).get(account.id) ?? (Number(account.initialBalance) || 0);
  if (Math.abs(balance) < 0.005) return null;
  return { balance, leaving: before };
}

/**
 * The envelope adjustment that keeps Unallocated where it was, or null for
 * "leave it to Unallocated". Leaving the budget's cash, the envelope gives
 * the money up (−balance); joining it, the envelope receives it.
 *
 * @param {{ balance: number, leaving: boolean }} move
 * @param {string | null} envelopeId
 * @param {{ id: string, date: string, note: string, nowIso: string }} meta
 */
export function moveAdjustment(move, envelopeId, { id, date, note, nowIso }) {
  if (!envelopeId) return null;
  const amount = Math.round((move.leaving ? -move.balance : move.balance) * 100) / 100;
  return {
    id, date, type: 'adjustment', target: 'envelope', target_id: envelopeId,
    amount, note, status: 'posted', created_at: nowIso, modified_at: nowIso,
  };
}
