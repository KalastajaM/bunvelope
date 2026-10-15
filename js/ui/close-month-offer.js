// js/ui/close-month-offer.js — on the first open of a new month, offer to
// close the month that just ended (owner decision 2026-10-05: a month is
// closed once it is over, and the app asks on the 1st).
//
// Which month to offer is the shared rule (`monthToOfferClosing` in
// js/core/closed-periods.js): the previous month, while it is still open and
// has rows. Whether it was already offered is a per-viewer convenience kept
// in localStorage per budget (with an in-memory copy when storage is missing
// or blocked), so "Not now" is not asked again for that month; the Review
// page still closes any month that has ended. The close itself is the
// `month.close` command, as on the Review page.

import { monthToOfferClosing } from '../state/closed-periods.js';
import { budgetKeyOf } from './page-filter.js';
import { confirmDialog } from './dialog.js';
import { dispatchOrReport } from './save-error.js';
import { toast } from './toast.js';
import { t, fmtMonthLang } from './i18n.js';

const PREFIX = 'bv.closeOffer.';

/** Months offered this page session, per budget key, when storage fails. */
const memory = new Map();

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @param {string | undefined | null} budgetKey */
export const closeOfferKey = (budgetKey) => `${PREFIX}${budgetKey || '_default'}`;

/**
 * Whether `month` was already offered for this budget; marks it offered.
 * @param {string} key
 * @param {string} month
 * @param {Storage | null} storage
 * @returns {boolean}
 */
function alreadyOffered(key, month, storage) {
  if (memory.get(key) === month) return true;
  memory.set(key, month);
  try {
    if (storage?.getItem(key) === month) return true;
    storage?.setItem(key, month);
  } catch { /* storage blocked or full: the in-memory copy stands */ }
  return false;
}

/**
 * Offers to close last month once. Resolves true when it was closed.
 * @param {{
 *   state: { meta: any, transactions: any[], budgetFolder?: any },
 *   session: { query: Function, dispatch: Function },
 *   now: Date,
 *   storage?: Storage | null,
 *   confirm?: (message: string, opts: any) => Promise<boolean>,
 *   stillCurrent?: () => boolean,
 * }} deps
 * @returns {Promise<boolean>}
 */
export async function offerToCloseLastMonth({
  state, session, now, storage = defaultStorage(), confirm = confirmDialog, stillCurrent = () => true,
}) {
  const month = monthToOfferClosing(state.meta, state.transactions, now);
  if (!month) return false;
  if (alreadyOffered(closeOfferKey(budgetKeyOf(state.budgetFolder)), month, storage)) return false;
  const review = session.query('review.month', { month });
  const negativeCount = review?.ok ? review.value.negativeCount : 0;
  const label = fmtMonthLang(month);
  const ok = await confirm(t('review.closeOffer')(label, negativeCount), {
    title: t('review.closeOfferTitle'),
    okLabel: t('review.closeOfferOk')(label),
    cancelLabel: t('review.notNow'),
  });
  if (!ok || !stillCurrent()) return false;
  const r = await dispatchOrReport(session, 'month.close', { month }, undefined, { failKey: 'review.closeFailed' });
  if (!r) return false;
  toast(t('review.closedToast')(label));
  return true;
}

/** Test hook: forget the in-memory offers. */
export function _resetCloseOfferMemory() { memory.clear(); }
