import { spendingProfiles, projectPlannedSpending } from '../engine/spending-profile.js';
import { lensTransactions } from '../engine/lens.js';
import { isPendingTargetTransfer, resolveTargetTransfers } from '../engine/target-transfers.js';
// js/core/effective-txs.js — "effective transaction lists": real rows plus
// the forecast rows for occurrences that have not been materialised yet,
// deduped against what is already posted and what the user deleted.
//
// Two lists live here, for two pages, and they deliberately differ:
//
//   • `buildEffectiveTxList` / `forecastRowsFor` — the Monthly Review's list,
//     which includes planned (hand-recorded) spend.
//   • `transactionsPageTxList` — the Transactions page's ledger, which shows
//     only rows Bunvelope would itself write, nets scheduled bills against
//     hand-recorded payments, and flags past occurrences overdue.
//
// Both were closures over `state` inside their pages, which is why omissions
// survived: nothing could assert what the lists contained without driving a
// browser. They share the dedup set (`takenOccurrenceKeys`), so tombstones
// cannot again be honoured by one and not the other.
//
// Pure: no DOM, no storage, no module state.

import {
  forecastScheduledTransactions,
  forecastAllFills,
  forecastPlannedExpenses,
  forecastKey,
  netForecastAgainstRealPayments,
  resolveSetSourceLegs,
} from '../engine.js';
import { netForecastAgainstRealPaymentsDetailed, netAgainstSpentThisMonth } from '../engine/envelope-forecast.js';

/**
 * Occurrence keys a forecast row must not re-emit: the `from_budget` tag of
 * every real transaction (the occurrence was materialised) plus the
 * occurrences the user deleted, `meta.scheduledTombstones`.
 *
 * Tombstones use the `from_budget` format itself (`${itemId}:${monthKey}`,
 * `tpl:${tplId}:${monthKey}`, …), which is what `forecastKey` produces for a
 * forecast row, so the same set dedupes both. The materialisers, the Forecast
 * lens and the envelope projection already treat a tombstone as taken; these
 * two lists did not, so a deleted bill came back as an upcoming row.
 *
 * Exported because every other list of expected rows (the reconcile window's
 * Scheduled box, the dashboard's upcoming card, the AI's what-if forecast)
 * needs the same set; each once built its own from `from_budget` alone, and a
 * bill deleted while reconciling came back in all three.
 */
export function takenOccurrenceKeys(transactions, tombstones) {
  const taken = new Set();
  for (const tx of transactions || []) {
    if (tx && typeof tx.from_budget === 'string') taken.add(tx.from_budget);
  }
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) taken.add(k);
  }
  return taken;
}

// Local-calendar YYYY-MM-DD, matching the page code this was lifted from.
function localYmd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Forecast rows for the window `(today, endStr]`, deduped against the
 * `from_budget` keys already carried by real transactions and against
 * `tombstones` (`meta.scheduledTombstones`, occurrences the user deleted).
 *
 * Three sources, and all three are needed:
 *
 *   1. `forecastScheduledTransactions` — items Bunvelope auto-posts.
 *   2. `forecastAllFills`              — template and income-driven fills.
 *   3. `forecastPlannedExpenses`       — planned spend Bunvelope does NOT
 *      auto-post.
 *
 * §2.7 — (3) was missing. `forecastScheduledTransactions` gates on
 * `item.as_schedule`, so a plan item that is included in the budget but
 * recorded by hand contributed nothing to the review's `scheduled` column and
 * nothing to the roll-forward that projects a future month. On the owner's
 * budget that is 23 of the 67 included items, every one of them carrying a
 * `monthly_schedule` — genuinely planned spending, just not automated. The
 * Envelopes and Transactions pages have always seen these rows, through
 * `plannedExpenseRows` in the lens; the Review page simply never called the
 * function.
 *
 * `projected` is `balance − max(scheduled, planned − actual)`, so where
 * `planned` was large and `actual` still small the `planned − actual` term
 * rescued it — but for an envelope whose plan had already been partly spent,
 * `projected`, `surplus` and `startNext` were all too high, and selecting a
 * future month compounded it.
 *
 * Both bill sources are netted against what the user has entered, the way
 * the envelope projection nets them (`projectEnvelopeBalance`): auto-post
 * rows against hand payments that `settles()` them, then planned rows, one
 * envelope at a time, through `netAgainstSpentThisMonth` (month by month,
 * entries dated ahead included, a bill paid early in the month before too).
 * Without it a payment typed in ahead was counted twice: once as itself in
 * `scheduled`, once as the forecast row. Rent entered for 3 Oct made
 * October's `scheduled` 2,400 and left `projected` and `surplus` a whole rent
 * low (2026-10-01). Netting runs before the window filter, so whether a
 * payment matches does not depend on the month the page is showing.
 *
 * This list used to skip the planned netting, on the grounds that the
 * function consumes a single pool and fed every envelope at once lets one
 * envelope absorb another's (the trap lens.js documents), and that skipping
 * it was "slightly conservative". The trap is per call, so per envelope it is
 * gone; and the double count was not slight. Netting spend up to today out
 * of `scheduled` cannot under-count either: `runMonthlyReview` takes
 * `max(scheduled, planned − actual)`, which still carries the unspent plan.
 *
 * Its rows are ID'd `planned:${item.id}:${occ.monthKey}` but KEYED
 * `${item.id}:${occ.monthKey}` — deliberately the key the materialiser would
 * write if the item were ever flipped to `as_schedule` — so the two sources
 * cannot double up.
 */
export function forecastRowsFor({
  transactions = [],
  budgetItems = [],
  envelopeTemplates = [],
  accounts = [],
  envelopes = [],
  today,
  endStr,
  fromStr = null,
  country = 'FI',
  tombstones = [],
}) {
  const todayStr = localYmd(today);
  const scheduled = netForecastAgainstRealPaymentsDetailed(
    forecastScheduledTransactions(budgetItems, accounts, envelopes, today, endStr, null, country, { transactions, pendingTargetTransfers: true }),
    { transactions, windowFromStr: todayStr, windowToStr: endStr },
  );
  // One envelope at a time: a pool shared across envelopes would let one
  // envelope's row absorb another's spend.
  const plannedByEnvelope = new Map();
  for (const row of forecastPlannedExpenses(budgetItems, accounts, envelopes, today, endStr, { country, monthlyBuckets: true })) {
    const id = row.envelope_id;
    if (!plannedByEnvelope.has(id)) plannedByEnvelope.set(id, []);
    plannedByEnvelope.get(id).push(row);
  }
  const planned = [];
  for (const [envelopeId, envRows] of plannedByEnvelope) {
    planned.push(...(envelopeId
      ? netAgainstSpentThisMonth(envRows, { envelopeId, transactions, startStr: todayStr, claimed: scheduled.claimed })
      : envRows));
  }
  const rows = scheduled.rows.concat(forecastAllFills(
    budgetItems, envelopeTemplates, accounts, envelopes, today, endStr, { country },
  )).concat(planned);

  const takenKeys = takenOccurrenceKeys(transactions, tombstones);

  const expanded = projectPlannedSpending(rows.filter(f => !takenKeys.has(forecastKey(f))), { today, end: endStr,
    profiles: spendingProfiles({ transactions, accounts, envelopes }, today) });
  const filtered = expanded.filter((f) => {
    if (takenKeys.has(forecastKey(f))) return false;
    if (f.date > endStr) return false;
    if (fromStr && f.date < fromStr) return false;
    return true;
  });
  return targetEstimatesFor({ transactions, budgetItems, envelopeTemplates, accounts, envelopes,
    meta: { country, scheduledTombstones: tombstones } }, filtered, today, endStr);
}

/**
 * `transactions` plus the forecast rows for the window. Returns the original
 * array unchanged when there is nothing to add, so callers keep the identity
 * the balance memoiser is keyed on.
 */
export function buildEffectiveTxList(opts) {
  const extra = forecastRowsFor(opts);
  if (!extra.length) return opts.transactions || [];
  // A template fill that tops a set-mode line up to its target and draws the
  // top-up from a source envelope is emitted with a `source_set_pending`
  // placeholder: the draw depends on the balance on that day, which only a
  // walk of the full list knows. Resolve it here, as the Forecast lens does.
  return resolveSetSourceLegs((opts.transactions || []).concat(extra));
}

/**
 * The Transactions page's row set: `transactions` alone when "show scheduled"
 * is off; otherwise `transactions` plus the scheduled bills and template fills
 * Bunvelope would write in the window, minus occurrences already materialised
 * or deleted (tombstoned).
 *
 * The window is today through today+30 days — one full cycle of every monthly
 * item without flooding the list — widened to `dateFrom` / `dateTo` when the
 * user's date filter reaches further. Occurrences dated before today (only
 * reachable through a past `dateFrom`) are flagged `is_overdue`.
 *
 * The scheduled leg is netted against payments recorded by hand: the key
 * dedup only matches rows the app materialised, so without it a bill typed
 * in ahead of its due date would print twice and the running balance would
 * count it twice. Same rule the envelope projection and the Forecast lens use.
 *
 * Planned (hand-recorded, non-`as_schedule`) spend is NOT included here, as
 * it never was: this is a ledger of rows, and those rows will be typed by
 * the user, not written by the app.
 *
 * Deliberately independent of the active balance lens: the page reconstructs
 * a chronological ledger, which needs the complete real history plus this
 * bounded preview. Feeding it the Forecast lens's rows would double-count.
 *
 * Lifted from a closure in js/pages/transactions.js; behaviour is unchanged
 * apart from honouring `tombstones`.
 *
 * @param {object} opts
 * @param {any[]} [opts.transactions]
 * @param {any[]} [opts.budgetItems]
 * @param {any[]} [opts.envelopeTemplates]
 * @param {any[]} [opts.accounts]
 * @param {any[]} [opts.envelopes]
 * @param {Date} opts.today            the page's clock (`now()` from app.js)
 * @param {boolean} [opts.showScheduled]
 * @param {string|null} [opts.dateFrom] the list's date filter, YYYY-MM-DD
 * @param {string|null} [opts.dateTo]
 * @param {string} [opts.country]
 * @param {any[]} [opts.tombstones]     `meta.scheduledTombstones`
 * @returns {any[]}
 */
export function transactionsPageTxList({
  transactions = [],
  budgetItems = [],
  envelopeTemplates = [],
  accounts = [],
  envelopes = [],
  today,
  showScheduled = false,
  dateFrom = null,
  dateTo = null,
  country = 'FI',
  tombstones = [],
}) {
  if (!showScheduled) return transactions;

  const todayStr = localYmd(today);
  const thirtyAhead = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
  let fromStr = todayStr;
  let endStr = localYmd(thirtyAhead);
  if (dateTo && dateTo > endStr) endStr = dateTo;
  if (dateFrom && dateFrom < fromStr) fromStr = dateFrom;

  const forecasts = netForecastAgainstRealPayments(
    forecastScheduledTransactions(
      budgetItems, accounts, envelopes, today, endStr, fromStr, country, { transactions, pendingTargetTransfers: true },
    ),
    { transactions, windowFromStr: fromStr, windowToStr: endStr },
  ).concat(forecastAllFills(
    budgetItems, envelopeTemplates, accounts, envelopes, today, endStr,
    { fromDateStr: fromStr, country },
  ));

  // `forecastKey` rather than a hand-composed key: a fill's key is not the
  // item:month pair, and a hand-composed one would never match, showing every
  // posted (or deleted) fill twice.
  const takenKeys = takenOccurrenceKeys(transactions, tombstones);
  const filtered = forecasts
    .filter(f => !takenKeys.has(forecastKey(f)))
    .map(f => (f.date < todayStr ? { ...f, is_overdue: true } : f));

  // Resolve set-mode source draws so the rows show the real top-up amount;
  // see buildEffectiveTxList.
  return resolveSetSourceLegs(transactions.concat(targetEstimatesFor({
    transactions, budgetItems, envelopeTemplates, accounts, envelopes,
    meta: { country, scheduledTombstones: tombstones },
  }, filtered, today, endStr)));
}

/** Give ledger previews the same target estimates as the full forecast, including
 * planned spending and tombstones. Past occurrences use only their dated rows.
 * @param {any} data @param {any[]} rows @param {Date} today @param {string} endStr
 * @returns {any[]}
 */
export function targetEstimatesFor(data, rows, today, endStr) {
  if (!rows.some(isPendingTargetTransfer)) return rows;
  const forecasts = lensTransactions(data, { lens: 'forecast', today, horizon: endStr });
  const targets = new Map(forecasts.filter(isPendingTargetTransfer).map(row => [row.id, row]));
  const history = data.transactions || [];
  const dated = resolveTargetTransfers(data.accounts || [], history.concat(rows)).slice(history.length);
  return dated.map(row => targets.get(row.id) || row);
}
