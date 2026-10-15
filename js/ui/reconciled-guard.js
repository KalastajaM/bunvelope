// js/ui/reconciled-guard.js — ask before changing a balance reconciled with
// the bank.
//
// A cleared row dated on or before an account's last reconcile is one the
// bank statement vouched for. Editing its amount, date or account, deleting
// it or un-clearing it moves the balance the user agreed, which bookkeeping
// treats as settled. Same soft lock as closed months (closed-period-guard.js):
// the write asks first and "Edit anyway" proceeds. The rule lives in
// js/engine/reconciled.js; edits that leave every reconciled balance where it
// was (a payee, an envelope, a note) pass without a prompt.

import { state } from '../app.js';
import { confirmDialog } from './dialog.js';
import { t, fmtDateLang } from './i18n.js';
import { fmt } from '../utils.js';
import { reconciledBalanceShift, isReconciledRow } from '../engine.js';

/**
 * The latest reconcile date among the accounts that vouch for `tx`, or null
 * when no reconciliation covers it. For the edit sheet's note.
 *
 * @param {any} tx
 * @param {any[]} [accounts]
 * @returns {string | null}
 */
export function reconciledOn(tx, accounts = state.accounts) {
  let latest = null;
  for (const a of accounts || []) {
    if (!isReconciledRow(tx, [a])) continue;
    const at = String(a.lastReconciledAt).slice(0, 10);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/**
 * Resolves true when the write may go ahead: it moves no reconciled balance,
 * or the user chose "Edit anyway". `before` holds the old versions of the rows
 * the write touches, `after` their new versions (none for a delete, none for
 * `before` on an insert).
 *
 * @param {any[]} before
 * @param {any[]} after
 * @param {any[]} [accounts]
 * @returns {Promise<boolean>}
 */
export async function confirmReconciledEdit(before, after, accounts = state.accounts) {
  const shifts = reconciledBalanceShift(accounts || [], before || [], after || []);
  if (shifts.length === 0) return true;
  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const lines = shifts.map(({ accountId, shift }) => {
    const a = byId.get(accountId);
    return t('reconciledRow.line')(a?.name || accountId, fmt(shift, { signed: true }), fmtDateLang(a?.lastReconciledAt));
  });
  const ok = await confirmDialog(t('reconciledRow.confirm')(lines.join('; ')), {
    title: t('reconciledRow.title'),
    okLabel: t('reconciledRow.editAnyway'),
    cancelLabel: t('common.cancel'),
  });
  return ok === true;
}
