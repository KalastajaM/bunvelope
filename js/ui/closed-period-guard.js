// js/ui/closed-period-guard.js — ask before changing a row in a closed month.
//
// The soft lock behind Review's "Close month": a write that adds, edits or
// deletes a transaction dated in a closed month confirms first, and "Edit
// anyway" proceeds. The rule (which months are closed, which dates hit them)
// lives in js/state/closed-periods.js.

import { state, now } from '../app.js';
import { confirmDialog } from './dialog.js';
import { t, fmtMonthLang } from './i18n.js';
import { closedMonthsIn } from '../state/closed-periods.js';

/**
 * Resolves true when the write may go ahead: no date is in a closed month, or
 * the user chose "Edit anyway". Pass every date the write touches, the old
 * and the new one for a row whose date changes.
 *
 * @param {Iterable<any>} dates
 * @param {number} [count=1]  rows the write changes inside closed months
 * @returns {Promise<boolean>}
 */
export async function confirmClosedEdit(dates, count = 1) {
  const months = closedMonthsIn(state.meta, dates, now());
  if (months.length === 0) return true;
  const label = months.map(fmtMonthLang).join(', ');
  const ok = await confirmDialog(t('closedPeriod.confirm')(Math.max(1, count), label), {
    title: t('closedPeriod.title'),
    okLabel: t('closedPeriod.editAnyway'),
    cancelLabel: t('common.cancel'),
  });
  return ok === true;
}
