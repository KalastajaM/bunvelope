import { projectPlannedSpending } from './spending-profile.js';
// js/engine/envelope-forecast.js — 12-month single-envelope balance projection
// and the recommendation rules built on top of it.
//
// Pure functions. No DOM, no I/O.
//
// The projection merges four event sources — real future-dated transactions,
// forecast scheduled expenses, forecast fills, and synthetic month-end rollover
// adjustments — then walks them day by day from today. Walking daily rather
// than month-to-month is the point: an envelope whose bill leaves on the 3rd
// and whose fill lands on the 25th is deeply negative mid-month and square by
// the 31st, and only a daily walk sees it.
//
// `projectEnvelopeBalance` is composition over four private units, split along
// the boundary the recommendation rules bisect across:
//
//   resolveWindow  — calendar arithmetic
//   gatherEvents   — merge, dedup, effect resolution, same-day ordering
//   walkDays       — the day simulation and rollover replay
//   summarize      — extrema
//
// The first two are invariant while the rules bisect on `fillDelta`, so a
// later caller can hoist them out of the loop instead of re-deriving the whole
// event set on every probe.

import { computeEnvelopeBalances, txEnvelopeEffect, txEnvelopeIds, txEnvelopeSpend, txRolloverReplayEffect } from './balances.js';
import {
  forecastScheduledTransactions, forecastAllFills, forecastPlannedExpenses, forecastKey,
  computeScheduledOccurrences, dueOccurrenceWindow, forecastDueAheadTransactions,
  forecastDueAheadTemplateFills, resolvePendingSetRow, loanOccurrenceSplit, loanOwedAt,
} from './scheduling.js';
import { txAbsAmount, isPostedTx } from './tx-amounts.js';
import { isForLaterMonth, occurrenceMonthOf, rolloverDelta } from './policies.js';
import { round2 } from '../utils.js';
import {
  LINK_DAY_WINDOW, CENT_EPSILON, requireClock, settles, dateDiffDays, loanItemsByLoanAccount, txLinkedItemId,
} from './_constants.js';

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = tx => (tx && tx.date ? String(tx.date).slice(0, 10) : '');

// `transactions` without its `is_forecast` rows, as the SAME array when there
// are none. The balance cache (balance-cache.js) memoizes on array identity,
// and a bisection re-projects dozens of times, so a fresh filtered copy per
// call would miss it every time; one copy per input array keeps it hitting.
/** @type {WeakMap<any[], any[]>} */
const realRowsMemo = new WeakMap();
/** @param {any[]} transactions */
function realRowsOnly(transactions) {
  if (!Array.isArray(transactions)) return [];
  let out = realRowsMemo.get(transactions);
  if (!out) {
    out = transactions.some(tx => tx && tx.is_forecast)
      ? transactions.filter(tx => tx && !tx.is_forecast)
      : transactions;
    realRowsMemo.set(transactions, out);
  }
  return out;
}

/**
 * Project one envelope's balance forward.
 *
 * input: {
 *   envelopeId, transactions, budgetItems, envelopeTemplates, accounts,
 *   envelopes, today, months = 12, country = 'FI',
 *   injections = [],   // hypothetical events (used by the recommendation rules)
 *   fillDelta  = 0,    // per-month change to this envelope's projected fills
 *   tombstones = [],   // scheduled-occurrence keys the user deleted (meta.scheduledTombstones)
 *   setDraws   = null, // a previous projection's `setDraws`, reused verbatim
 * }
 *
 * Returns {
 *   opening, dueUnposted, events, daily, months, low, high, closing,
 *   firstNegative, fillSource, monthlyFill, setDeltas, setDraws,
 * }
 *
 * The returned `events` carry their *pre-`fillDelta`* effects: the delta is a
 * property of the walk, not of the event set, so that the event set stays
 * reusable across a bisection.
 *
 * ── Set-mode forecast fills ──
 * A forecast `set` line on THIS envelope needs nothing special: the walk
 * overwrites the balance it has walked to with the target, so its effective
 * delta is `target − walked balance` by construction (`setDeltas` records
 * it, keyed by `setDrawKey`). The other side is the funding source: a
 * template with `schedule.source_envelope_id` and a set line draws the
 * source by that same delta, which only the TARGET's walk knows. So when
 * this envelope is the source of a `source_set_pending` row, the target is
 * projected (same window, no hypotheticals) and its recorded delta is what
 * the source line draws — the two walks agree by construction. `setDraws`
 * returns the deltas used, and the recommendation rules pass it back in so a
 * bisection does not re-project the targets on every probe (nothing the
 * rules vary on this envelope can move another envelope's walk).
 *
 * @returns {EnvelopeProjection}
 */
export function projectEnvelopeBalance(input) {
  const {
    envelopeId,
    transactions = [],
    budgetItems = [],
    envelopeTemplates = [],
    accounts = [],
    envelopes = [],
    today,
    months = 12,
    country = 'FI',
    injections = [],
    fillDelta = 0,
    tombstones = [],
    setDraws: knownDraws = null,
    setChain = [],
  } = input || {};

  const window = resolveWindow(today, months);

  if (!envelopeId) return unresolvedProjection(window.startStr);

  // An envelope we cannot resolve produces no events, and a flat-zero
  // projection reads exactly like a well-funded one to every downstream rule.
  // Say so explicitly instead — and do not throw, the caller is a UI sheet.
  const envelope = (envelopes || []).find(e => e && e.id === envelopeId) || null;
  if (!envelope || envelope.archived) return unresolvedProjection(window.startStr);

  // `forecastScheduledTransactions` deliberately starts TOMORROW (see its own
  // docblock), so a bill due today or earlier that has not been posted yet —
  // real money already owed, just not recorded — is in neither `realFuture`
  // nor the forecast set. `opening` then reads as fully funded for exactly as
  // long as it takes someone to run post-due, and every rule downstream
  // (including the trim/overfunded check) calls that envelope healthy on the
  // strength of a bill that is about to land. Fold it into `opening` instead
  // of injecting a past-dated event: `walkDays` never revisits a day before
  // the window starts, so a dated event here would silently never apply.
  const due = dueUnpostedTotal({
    envelopeId, budgetItems, transactions, accounts, today: window.start, tombstones, country,
  });
  const dueUnposted = due.total;
  // Real rows only. `realFuture` already skips `is_forecast` rows, and the
  // opening has to agree: a caller passing a Forecast-lens list would
  // otherwise count its generated rows here AND regenerate them as events.
  const realTxs = realRowsOnly(transactions);
  const opening = round2(
    (computeEnvelopeBalances(realTxs, { asOf: window.start }).get(envelopeId) || 0) - dueUnposted,
  );

  // The funding-source side of set-mode forecast fills — see the docblock.
  // `setChain` names the envelopes already being projected for this purpose,
  // so two templates funding each other's set lines cannot recurse forever;
  // a draw the chain cannot resolve counts only the add part (delta 0).
  /** @type {Map<string, number>} */
  const setDraws = new Map();
  /** @type {Map<string, EnvelopeProjection>} */
  const targets = new Map();
  const chain = Array.isArray(setChain) ? setChain : [];
  const setDrawFor = (row, targetId) => {
    const key = setDrawKey(row, targetId);
    let d = 0;
    if (knownDraws instanceof Map && knownDraws.has(key)) {
      d = Number(knownDraws.get(key)) || 0;
    } else if (targetId !== envelopeId && !chain.includes(targetId)) {
      let p = targets.get(targetId);
      if (!p) {
        p = projectEnvelopeBalance({
          ...input, envelopeId: targetId, injections: [], fillDelta: 0,
          setDraws: null, setChain: [...chain, envelopeId],
        });
        targets.set(targetId, p);
      }
      d = (p.setDeltas && p.setDeltas.get(key)) || 0;
    }
    setDraws.set(key, d);
    return d;
  };

  const { events, fillPlan } = gatherEvents({
    envelopeId, transactions, budgetItems, envelopeTemplates, accounts,
    envelopes, window, months, country, injections, tombstones,
    // Whatever hand-recorded spend `dueUnpostedTotal` already claimed is spoken
    // for; the planned-row netting downstream must not spend it a second time.
    spentPoolUsed: due.poolUsed,
    dueClaimedTxIds: due.claimedTxIds,
    dueAhead: due.ahead,
    setDrawFor,
  });

  const rollover = envelope.rollover || 'carry';
  // An early occurrence may already be in the opening balance. Keep its
  // effect separate too; otherwise opening the projection after its payment
  // date would change the month-end answer.
  const early = realTxs.filter(tx => isForLaterMonth(tx, window.startStr.slice(0, 7))
    && dayOf(tx) <= window.startStr).sort((a, b) => dayOf(a).localeCompare(dayOf(b)));
  const earlySet = new Set(early);
  const ownOpening = early.length
    ? round2((computeEnvelopeBalances(realTxs.filter(tx => !earlySet.has(tx)), { asOf: window.start }).get(envelopeId) || 0) - dueUnposted)
    : opening;
  const openingEffects = early.map(tx => txRolloverReplayEffect(tx, envelopeId)).filter(Boolean);
  const walked = walkDays(events, opening, window, rollover, fillDelta, envelopeId, ownOpening, openingEffects);
  const summary = summarize(walked.daily);

  return {
    envelopeId,
    opening,
    dueUnposted,
    events,
    daily: walked.daily,
    months: walked.months,
    ...summary,
    fillSource: fillPlan.source,
    monthlyFill: fillPlan.amount,
    setDeltas: walked.setDeltas,
    setDraws,
  };
}

/**
 * Key for one set line's resolved delta: the forecast row's dedup key plus
 * the envelope the line sets. Shared by the target's walk (which records it)
 * and the source's projection (which reads it).
 *
 * @param {any} row
 * @param {string} envelopeId
 */
function setDrawKey(row, envelopeId) {
  return `${forecastKey(row)}|${envelopeId}`;
}

/**
 * Sum of this envelope's auto-post EXPENSE items whose current occurrence is
 * already due (date <= today) but has not been posted — exactly what
 * `post-due` would materialize right now, restricted to this one envelope.
 *
 * Scoped to auto-post (`as_schedule`) expense items only. Income and
 * investment_transfer items are excluded: an unposted FILL is money not yet
 * arrived, not money already spent, so folding it into `opening` the same way
 * would understate the balance rather than correct it — a different, and here
 * deliberately unhandled, asymmetry.
 *
 * The lookback bound mirrors `materializeDueBudgetItems` in scheduling.js
 * exactly (the real `post-due` materialiser), through the shared
 * `dueOccurrenceWindow`: `as_schedule_since` when set, else the current
 * calendar month plus any occurrence a working-day shift carried into it from
 * the last days of the previous one. This is deliberately NOT a
 * full year back — an item with no `as_schedule_since` and a schedule
 * covering all 12 months would otherwise look "overdue" for months before
 * it was ever created, since nothing was posted for them. Matching the
 * materialiser's own bound keeps this helper's total identical to what
 * running `post-due` right now would actually produce.
 *
 * Also excludes `tombstones` (occurrences the user explicitly deleted), the
 * same set `materializeDueBudgetItems` treats as "already exists" so it
 * never resurrects them. Without this, an occurrence a user deleted because
 * a fee did not apply that month (e.g. a waived charge) reads as a real
 * backlog forever, since nothing will ever post a transaction for it.
 *
 * Finally, an occurrence is dropped when an untagged payment in this envelope
 * looks like the money that settled it. The `from_budget` key is the only hard
 * evidence a bill was paid, and it is absent whenever the payment was recorded
 * by hand instead of by `post-due` — including after a user cleans up a
 * double-booking and happens to delete the tagged copy. Without this the bill
 * is charged twice: once as the real transaction inside the balance, once
 * again here as a phantom backlog, and `opening` starts a full payment below
 * the balance the envelope card shows. Every downstream figure — low, spare,
 * every recommendation — inherits that gap, which is how a fully funded
 * envelope reports spare equal to minus one whole bill.
 *
 * "Looks like" is `settles()`: the same amount to the cent, within
 * `LINK_DAY_WINDOW` days. Deliberately NOT the loose pool `netAgainstSpentThisMonth`
 * consumes, and the difference matters. Pooling any outflow would let ordinary
 * spending settle a bill nobody paid — three unrelated purchases in a Home
 * envelope erasing an unpaid property tax — which hides a real shortfall
 * behind a healthy-looking forecast. Refusing to recognise a partial or
 * amended payment merely leaves the old double-charge in place, which
 * overstates the problem instead of concealing it. Between a false negative
 * that hides a hole and a false positive that shows one too large, this takes
 * the second.
 *
 * Unlike `findUnlinkedScheduledPayments` it does NOT require the match to be
 * unique, because it asks a different question. "Was this bill paid?" is
 * answered by any plausible payment — two identical rows for one bill mean it
 * was certainly paid. Only "which row should carry the key?" needs the
 * ambiguity resolved, and that is the repair's problem, not the forecast's.
 *
 * Returns { total, poolUsed, claimedTxIds, ahead } — `poolUsed` being how
 * much of the START month's untagged spend was claimed, which the caller hands
 * to `netAgainstSpentThisMonth` so the same money is not spent twice.
 *
 * `ahead` holds the occurrences this window owns whose working-day shift put
 * the PAYMENT after today (payment_day 31, next_work_day, on a Saturday the
 * 31st). They are not a backlog, but no other source has them either:
 * `forecastScheduledTransactions` starts at tomorrow's SCHEDULE date. They are
 * returned as forecast rows so the walk charges them on the day they pay.
 */
function dueUnpostedTotal({
  envelopeId, budgetItems, transactions, accounts, today, tombstones = [],
  country = 'FI',
}) {
  const todayStr = ymd(today);
  const startMonth = todayStr.slice(0, 7);
  // §4.1 — mirror the materialiser's account gate. `materializeDueBudgetItems`
  // skips an `as_schedule` item whose `account_id` is missing or does not
  // resolve (scheduling.js:374), so an item in that state can never post. This
  // function applied no such gate, and charged the occurrence against the
  // projection's `opening` forever — a permanent phantom debt for a bill the
  // app has already decided it will not write.
  const acctIds = new Set((accounts || []).map(a => a?.id).filter(Boolean));
  const postable = it => !!it.account_id && acctIds.has(it.account_id);
  const items = (budgetItems || []).filter(it => it
    && it.envelope_id === envelopeId
    && it.as_schedule
    && it.kind !== 'income'
    && it.kind !== 'investment_transfer'
    && it.kind !== 'account_transfer'
    && it.include !== false
    && postable(it));
  if (!items.length) return { total: 0, poolUsed: 0, claimedTxIds: new Set(), ahead: [] };

  const posted = new Set();
  for (const tx of transactions || []) {
    if (tx && typeof tx.from_budget === 'string') posted.add(tx.from_budget);
  }
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) posted.add(k);
  }

  const due = [];
  const ahead = [];
  let earliestFrom = todayStr;
  const acctById = new Map((accounts || []).filter(a => a && a.id).map(a => [a.id, a]));
  for (const item of items) {
    // A loan payment is what its method and what is still owed make it, not
    // the plan's amount, and nothing once the loan is repaid (the
    // materialiser posts nothing then, so it is no backlog either).
    const loan = item.kind === 'loan_payment' ? acctById.get(item.to_account_id) : null;
    if (item.kind === 'loan_payment' && !loan) continue;
    let owed = loan ? loanOwedAt(loan, transactions, todayStr) : 0;
    /** @param {{ date: string, amount: number, monthKey: string }} occ @returns {number | null} */
    const paymentOf = (occ) => {
      if (!loan) return round2(Math.abs(occ.amount));
      if (!(owed > 0)) return null;
      const split = loanOccurrenceSplit(item, loan, occ, owed, { country });
      owed = round2(owed - split.principal);
      const total = round2(split.principal + split.interest + split.fee);
      return total > 0 ? total : null;
    };
    // The materialiser's own window, shared rather than re-derived, so the
    // two cannot drift — see `dueOccurrenceWindow`.
    const win = dueOccurrenceWindow(item.as_schedule_since, today);
    const from = win.fromStr;
    // Same working-day options the materialiser uses. Without them this
    // computed the RAW schedule date where `materializeDueBudgetItems` uses
    // the adjusted one, so around a boundary post-due could post a bill the
    // forecast had not yet counted as due.
    const opts = { dayType: item.schedule_day_type, country };
    for (const occ of computeScheduledOccurrences(item, from, todayStr, opts)) {
      if (!win.owns(occ)) continue;
      if (posted.has(`${item.id}:${occ.monthKey}`)) continue;
      // The window owns an occurrence by its schedule date; a working-day
      // adjustment can still put the payment in the future. Money not yet owed
      // is not a backlog — but it is still coming, so hand it to the walk.
      const amount = paymentOf(occ);
      if (amount === null) continue;
      if (occ.date > todayStr) {
        ahead.push(dueAheadRow(item, { ...occ, amount }));
        continue;
      }
      if (from < earliestFrom) earliestFrom = from;
      due.push({ date: occ.date, amount, itemId: item.id });
    }
  }
  if (due.length === 0) return { total: 0, poolUsed: 0, claimedTxIds: new Set(), ahead };

  // Only a payment that LOOKS like this bill settles it. The pool reaches back
  // a further window's worth of days than the occurrences do, because a bill
  // may be paid before its due date.
  const pool = untaggedOutflowRows({
    envelopeId,
    transactions,
    fromStr: ymd(new Date(Date.parse(`${earliestFrom}T00:00:00Z`) - LINK_DAY_WINDOW * 86400000)),
    toStr: todayStr,
    loanLinks: loanItemsByLoanAccount(budgetItems),
  });

  let total = 0;
  let poolUsed = 0;
  const claimed = new Set();
  for (const occ of [...due].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const match = nearestSettlingPayment(occ, pool, claimed);
    if (!match) {
      total = round2(total + occ.amount);
      continue;
    }
    // Only spend inside the START month is visible to the planned-row netting
    // downstream, so only that part has to be reported back. A linked payment
    // is not in that pool at all (it nets only its own item there), so it is
    // never reported.
    for (const row of [match, ...samePaymentRows(match, pool, claimed)]) {
      claimed.add(row);
      if (!row.userLinked && row.date.slice(0, 7) === startMonth) poolUsed = round2(poolUsed + row.amount);
    }
  }
  // The forward netting draws on an overlapping range of the same
  // transactions, so it needs the identities — not just the total — of the
  // rows spent here. An amount cannot say WHICH payment was consumed, and
  // that is exactly what stops one payment settling a past occurrence and a
  // future one. Rows with no id are unmatchable and simply never excluded.
  const claimedTxIds = new Set();
  for (const row of claimed) if (row.id != null) claimedTxIds.add(row.id);
  return { total: round2(total), poolUsed, claimedTxIds, ahead };
}

/**
 * The forecast row for an owned occurrence whose payment is still ahead —
 * the same shape `forecastScheduledTransactions` emits for an expense item, so
 * the netting and key dedup downstream treat it like any other.
 */
function dueAheadRow(item, occ) {
  return {
    id: `forecast:${item.id}:${occ.monthKey}`,
    is_forecast: true,
    forecast_budget_item_id: item.id,
    forecast_month_key: occ.monthKey,
    date: occ.date,
    status: 'scheduled',
    account: item.account_id,
    note: null,
    type: 'expense',
    amount: Math.abs(occ.amount),
    envelope_id: item.envelope_id,
    payee: item.description || '',
  };
}

// `settles()` lives in _constants.js (monthly-review.js needs it too and
// cannot import this module: this module imports it); re-exported here,
// where callers have always found it.
export { settles };

/**
 * The closest unclaimed payment that could have settled `occ`, or null.
 *
 * Closest by date rather than first-in-list so that two occurrences of the
 * same item and amount (a bill charged twice a year, both due inside one
 * lookback) each take the payment actually next to them. A payment linked to
 * the occurrence's item beats an unlinked one at any distance: the link is
 * the user's word, the amount only evidence.
 */
/**
 * The other rows of one payment: pool rows linked to the same item on the
 * same day as `match`. A loan payment recorded by hand is up to three rows
 * (principal, interest, other costs), each linked to the loan item; once one
 * of them settles the occurrence the others are part of that payment, not
 * spend left over for another bill or a planned row.
 */
function samePaymentRows(match, pool, claimed) {
  if (!match.itemId) return [];
  return pool.filter(r => r !== match && !claimed.has(r) && r.itemId === match.itemId && r.date === match.date);
}

function nearestSettlingPayment(occ, pool, claimed) {
  let best = null;
  let bestRank = Infinity;
  for (const row of pool) {
    if (claimed.has(row)) continue;
    if (!settles(row, occ)) continue;
    const gap = Math.abs(dateDiffDays(row.date, occ.date));
    const rank = (row.itemId ? 0 : 100000) + gap;
    if (rank < bestRank) { best = row; bestRank = rank; }
  }
  return best;
}

/** Spending available to net against an envelope, or Unallocated (null).
 * @param {any} tx
 * @param {string|null} envelopeId
 * @returns {number}
 */
function forecastSpend(tx, envelopeId) {
  if (envelopeId) return txEnvelopeSpend(tx, envelopeId);
  if (tx?.type !== 'expense') return 0;
  const allocated = txEnvelopeIds(tx).reduce((sum, id) => sum + txEnvelopeSpend(tx, id), 0);
  return Math.max(0, round2(txAbsAmount(tx) - allocated));
}

/**
 * This envelope's UNTAGGED outflows inside an inclusive date range — money the
 * user recorded by hand, which carries no `from_budget` and so can never be
 * matched back to the budget item that predicted it.
 *
 * The single pool both double-count guards draw on. `dueUnpostedTotal` claims
 * from it first and reports what it took, so `netAgainstSpentThisMonth` can
 * subtract that before netting its own rows: the two cover disjoint budget
 * items (`forecastPlannedExpenses` skips `as_schedule`) but read the same
 * transactions, and spending one hand-recorded payment twice would understate
 * the projection exactly as badly as spending it zero times overstates it.
 *
 * Rows carrying `from_budget` are excluded because key dedup already handles
 * them, and the pool is drawn with `txEnvelopeSpend` rather than
 * `txEnvelopeEffect`: this is the SPEND question, not the balance question.
 *
 * §2.9 — it used to admit any transaction whose effect on the envelope was
 * negative. `txEnvelopeEffect` is the balance question, and balances.js:285
 * documents at length why that is deliberately not the spend question: a fill
 * relocating money out of an envelope, an outbound envelope transfer and a
 * negative adjustment all move the balance down, and none of them is a bill
 * being paid. Netting a planned bill against one of those cancels a projected
 * hole with money that was moved rather than spent, and the envelope reads
 * healthy when it is not — the false-negative direction
 * (04-forecast-and-history.md §4.3) that hides a shortfall.
 *
 * Returned date-sorted, oldest first, with `amount` a positive magnitude.
 *
 * `id` and `payee` ride along for `findUnlinkedScheduledPayments`, which needs
 * to name the row it proposes to tag. The netting callers ignore both.
 *
 * With `loanLinks` (`loanItemsByLoanAccount`), a hand-recorded `debt_payment`
 * into a loan one scheduled item pays is linked to that item (`itemId`) for
 * `settles()`. `userLinked` says whether the link is the user's own
 * `budget_item_id`: `netAgainstSpentThisMonth` builds its pool without loan
 * links, so what a caller reports to it as linked must be only those.
 *
 * @param {{ envelopeId: string|null, transactions: any[], fromStr: string, toStr: string,
 *   loanLinks?: Map<string, string> | null }} opts
 */
function untaggedOutflowRows({ envelopeId, transactions, fromStr, toStr, loanLinks = null }) {
  const rows = [];
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    if (typeof tx.from_budget === 'string' && tx.from_budget) continue;
    const d = dayOf(tx);
    if (!d || d < fromStr || d > toStr) continue;
    const spent = forecastSpend(tx, envelopeId);
    if (!(spent > 0)) continue;
    rows.push({
      id: tx.id ?? null,
      date: d,
      amount: spent,
      payee: tx.payee || tx.description || tx.note || '',
      // The budget item the user linked this payment to (fill %), or the loan
      // item its loan names, which `settles()` honours over the amount.
      itemId: txLinkedItemId(tx, loanLinks, envelopeId),
      userLinked: !!txLinkedItemId(tx, null, envelopeId),
      type: tx.type,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/**
 * Posted, UNTAGGED real transfers from `fromAccount` to `toAccount` inside an
 * inclusive date range — the candidates for settling a planned transfer's
 * occurrence. Same row shape as `untaggedOutflowRows`, so `settles()` reads
 * both. Direction is part of the match: a transfer the other way is a
 * different movement of money, not an early or late one.
 */
function untaggedTransferRows({ fromAccount, toAccount, transactions, fromStr, toStr }) {
  const rows = [];
  for (const tx of transactions || []) {
    if (!tx || tx.type !== 'account_transfer' || !isPostedTx(tx)) continue;
    if (typeof tx.from_budget === 'string' && tx.from_budget) continue;
    if (tx.from_account !== fromAccount || tx.to_account !== toAccount) continue;
    const d = dayOf(tx);
    if (!d || d < fromStr || d > toStr) continue;
    const amount = txAbsAmount(tx);
    if (!(amount > 0)) continue;
    rows.push({
      id: tx.id ?? null,
      date: d,
      amount,
      payee: tx.payee || tx.description || tx.note || '',
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/**
 * Drop the forecast scheduled occurrences a real payment already accounts for,
 * and return the rest.
 *
 * Key dedup — matching a forecast row to the transaction carrying its
 * `from_budget` — only ever sees rows the app itself materialized. That key is
 * absent exactly when the user recorded the payment by hand, which is the
 * ordinary case rather than the edge one: a tax installment typed in ahead of
 * its due date, a bill paid a few days early. The forecast then counts the
 * user's transaction AND the budget item's own occurrence, and spends the
 * money twice. In a projection that is a whole phantom bill of outflow in the
 * month it lands; in the Forecast lens it is a wrong balance; on the
 * Transactions list it is the same bill printed twice.
 *
 * `dueUnpostedTotal` solves this for occurrences already due, on the same
 * evidence. This is the general form, shared by every surface that generates
 * forecast rows — hence envelope-agnostic: rows are grouped by the envelope
 * they spend from, and each envelope's occurrences may only be settled by
 * payments out of that same envelope.
 *
 * The predicate is `settles()`: same amount to the cent, within
 * `LINK_DAY_WINDOW` days, each payment claimable once, earliest occurrence
 * choosing first. The trade it makes is worth restating. A coincidentally
 * identical outflow beside a due date WILL cancel the bill. Refusing to match
 * leaves a double charge, which invents a shortfall the envelope does not have
 * and sends the user to fund money that was never missing. Matching too
 * eagerly hides one payment behind another the user can see sitting in the
 * same envelope, days apart, for the same amount. The second is recoverable by
 * looking; the first is not.
 *
 * The caller passes the window it generated `forecastRows` for, and the pool
 * is derived from it: one match window back from the start, up to the end. The
 * contract that makes this correct is on the caller, and it is the whole
 * argument — every transaction the pool can reach must ALREADY be counted
 * exactly once by the caller, in an opening balance if it is past, in the walk
 * or row list if it is ahead. Netting against a payment outside that deletes
 * the outflow rather than counting it once, which is the opposite error and
 * the worse one, so the upper bound is the window end and never further.
 *
 * Reaching BACK before the window start is what catches a bill paid early —
 * occurrence still ahead, payment already made. `excludeTxIds` carries the
 * rows another netting pass over the same transactions has already spent, so
 * one payment cannot settle a past occurrence and a coming one.
 *
 * Rows that spend from no envelope, or from more than one, pass through
 * untouched: a split forecast row has no single pool to draw on, and no
 * generator emits one today.
 */
export function netForecastAgainstRealPayments(
  forecastRows,
  /** @type {{ transactions: any[], windowFromStr: string, windowToStr: string, excludeTxIds?: Set<string> | null }} */
  opts,
) {
  return netForecastAgainstRealPaymentsDetailed(forecastRows, opts).rows;
}

/**
 * A payment `netForecastAgainstRealPayments` spent settling a forecast row.
 * `amount` is the envelope-side spend, the same figure the planned-row pool
 * in `netAgainstSpentThisMonth` reads for that transaction. `itemId` is the
 * payment's budget-item link, null when it has none.
 *
 * @typedef {{ envelopeId: string|null, id: any, date: string, amount: number, itemId?: string | null }} ClaimedPayment
 */

/**
 * `netForecastAgainstRealPayments`, also reporting WHICH payments it spent.
 *
 * Callers that go on to net planned rows against the same month's spend need
 * this: a payment that cancelled an auto-post bill here is already accounted
 * for, and letting it also shrink a planned row nets one payment twice — 200
 * paid by hand for a 200 bill then also took 200 off the groceries plan, and
 * the projection closed 200 too high, hiding the shortfall it exists to show.
 * Hand `claimed` to `netAgainstSpentThisMonth`.
 *
 * @param {any[]} forecastRows
 * @param {{ transactions: any[], windowFromStr: string, windowToStr: string, excludeTxIds?: Set<string> | null }} opts
 * @returns {{ rows: any[], claimed: ClaimedPayment[] }}
 */
export function netForecastAgainstRealPaymentsDetailed(
  forecastRows,
  { transactions, windowFromStr, windowToStr, excludeTxIds = null },
) {
  /** @type {ClaimedPayment[]} */
  const claimedOut = [];
  const byEnvelope = new Map();
  for (const row of forecastRows) {
    const date = dayOf(row);
    if (!date) continue;
    const envIds = txEnvelopeIds(row);
    const unallocated = row.type === 'expense' && !row.envelope_id && !row.envelope_splits?.length;
    if (!unallocated && envIds.length !== 1) continue;
    const envelopeId = unallocated ? null : envIds[0];
    const effect = envelopeId ? txEnvelopeEffect(row, envelopeId) : { mode: 'add', amount: -forecastSpend(row, null) };
    if (!effect || effect.mode !== 'add' || effect.amount >= 0) continue;
    if (!byEnvelope.has(envelopeId)) byEnvelope.set(envelopeId, []);
    byEnvelope.get(envelopeId).push({
      row,
      occ: { date, amount: round2(Math.abs(effect.amount)), itemId: row.forecast_budget_item_id || null },
    });
  }
  if (byEnvelope.size === 0) return { rows: forecastRows, claimed: claimedOut };

  // A loan payment forecasts as up to three rows (principal, interest, other
  // costs), but it is one occurrence: a payment linked to the item that
  // settles any of its rows settles them all. The loan an item's principal row pays names that item
  // for a payment recorded by hand, as `loanItemsByLoanAccount` does from the
  // plan; a loan two items pay names neither.
  const legKey = (row) => (row.forecast_loan_leg && row.forecast_budget_item_id
    ? `${row.forecast_budget_item_id}:${row.forecast_month_key}` : null);
  /** @type {Map<string, string>} */
  const loanLinks = new Map();
  const sharedLoans = new Set();
  for (const row of forecastRows) {
    if (row.forecast_loan_leg !== 'principal' || !row.to_account || !row.forecast_budget_item_id) continue;
    const prev = loanLinks.get(row.to_account);
    if (prev && prev !== row.forecast_budget_item_id) sharedLoans.add(row.to_account);
    else loanLinks.set(row.to_account, row.forecast_budget_item_id);
  }
  for (const loanId of sharedLoans) loanLinks.delete(loanId);
  const settledLoanOccurrences = new Set();

  const settled = new Set();
  for (const [envelopeId, occurrences] of byEnvelope) {
    let pool = untaggedOutflowRows({
      envelopeId,
      transactions,
      fromStr: shiftDays(windowFromStr, -LINK_DAY_WINDOW),
      toStr: windowToStr,
      loanLinks: loanLinks.size ? loanLinks : null,
    });
    if (excludeTxIds && excludeTxIds.size) {
      pool = pool.filter(r => r.id == null || !excludeTxIds.has(r.id));
    }
    if (pool.length === 0) continue;

    const claimed = new Set();
    occurrences.sort((a, b) => (a.occ.date < b.occ.date ? -1 : a.occ.date > b.occ.date ? 1 : 0));
    for (const { row, occ } of occurrences) {
      // Another row of this loan payment already found its payment.
      if (settledLoanOccurrences.has(legKey(row))) continue;
      const match = nearestSettlingPayment(occ, pool, claimed);
      if (!match) continue;
      const paidWith = [match, ...samePaymentRows(match, pool, claimed)];
      for (const r of paidWith) claimed.add(r);
      settled.add(row);
      // A payment linked to the loan item is the whole instalment; an amount
      // look-alike only stands in for the one row it matched.
      const lk = legKey(row);
      if (lk && match.itemId) settledLoanOccurrences.add(lk);
      // Only the user's own link is reported as one: the planned-row netting
      // downstream pools a payment linked by its loan as unlinked spend.
      for (const r of paidWith) {
        claimedOut.push({ envelopeId, id: r.id, date: r.date, amount: r.amount, itemId: r.userLinked ? r.itemId : null });
      }
    }
  }

  const isSettled = (r) => settled.has(r) || settledLoanOccurrences.has(legKey(r));
  return {
    rows: settled.size === 0 ? forecastRows : forecastRows.filter(r => !isSettled(r)),
    claimed: claimedOut,
  };
}

/**
 * Shift an ISO day string by whole days, in local time.
 *
 * Deliberately not `Date.parse(...) + n * 86400000`: that reads the string as
 * UTC and formats the result locally, so west of Greenwich it lands a day
 * short. Every bound here is compared against local `ymd()` strings.
 */
function shiftDays(dayStr, n) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  if (!y || !m || !d) return dayStr;
  return ymd(new Date(y, m - 1, d + n));
}

/**
 * Linked candidates for one occurrence, with the rows of one payment folded
 * into one: rows linked to the item on the same day are the principal,
 * interest and other costs of a loan payment recorded by hand, and counting
 * them apart would read as two payments for one bill (ambiguous, so the
 * occurrence would post again). The principal stands for the payment, else
 * the largest row. Rows on different days stay apart: that is two payments.
 *
 * @template {{ row: { date: string, amount: number, type?: string } }} P
 * @param {P[]} linked
 * @returns {P[]}
 */
function onePaymentPerDay(linked) {
  /** @type {Map<string, P>} */
  const byDay = new Map();
  for (const p of linked) {
    const cur = byDay.get(p.row.date);
    const better = !cur
      || (p.row.type === 'debt_payment') > (cur.row.type === 'debt_payment')
      || ((p.row.type === 'debt_payment') === (cur.row.type === 'debt_payment') && p.row.amount > cur.row.amount);
    if (better) byDay.set(p.row.date, p);
  }
  return [...byDay.values()];
}

/**
 * Orphaned payments: an auto-post (`as_schedule`) bill that was plainly paid,
 * by a real transaction carrying no `from_budget` key to say so.
 *
 * The key is the only link between a scheduled occurrence and the money that
 * settled it. Absent, two things go wrong and neither is visible: the forecast
 * has to infer the bill was paid (`dueUnpostedTotal`, on the same `settles()`
 * evidence), and `materializeDueBudgetItems` is still free to post a duplicate
 * for that occurrence on the next folder open. Restoring the key ends both —
 * it is the difference between inferring a fact every render and recording it.
 *
 * Shares `settles()` with the forecast, then adds a condition the forecast
 * does not need, because writing a key is a data edit that suppresses a future
 * post: the pairing must be MUTUALLY unique — exactly one candidate payment
 * for the occurrence, and that payment a candidate for no other one. The
 * forecast only asks whether the bill was paid, which any plausible payment
 * answers; naming the row that pays it is what needs the ambiguity gone.
 *
 * Mutual uniqueness is what makes the double-booking case safe. Two identical
 * payments for one bill are exactly the situation where a machine cannot know
 * which row is "the" payment, so both are left alone and the user decides.
 * Once the duplicate is gone the survivor is unambiguous and gets proposed.
 *
 * The occurrence window mirrors `dueUnpostedTotal` and `materializeDueBudgetItems`
 * (`dueOccurrenceWindow`: `as_schedule_since`, else the current month plus any
 * occurrence shifted into it) — deliberately, not
 * for symmetry's sake. Outside it an occurrence is neither charged as a backlog
 * nor eligible to be posted, so tagging its payment would change nothing and
 * could only ever be wrong.
 *
 * Planned transfers (`kind: 'account_transfer'`, scheduled and enabled, with
 * two different accounts) are matched the same way, against posted untagged
 * real transfers with the same from and to accounts — but only when no
 * `envelopeId` is given: a transfer belongs to no envelope, so an
 * envelope-scoped call stays bills-only. Mutual uniqueness is judged across
 * bills and transfers together.
 *
 * With `accounts`, an item is considered only if the materialiser would post
 * it: its `account_id` (and a transfer's `to_account_id`) must name an
 * account that still exists. Writing a key for an item that can never post
 * suppresses nothing and records a payment against an account that is gone.
 * Without `accounts` the check is skipped, as before it existed.
 *
 * Pure. Proposes; writes nothing.
 *
 * Returns Array<{ key, itemId, itemDescription, envelopeId, envelopeName,
 * monthKey, dueDate, dueAmount, txId, txDate, txPayee, txAmount }>, oldest
 * due date first. A transfer's row has `envelopeId: null`, `envelopeName: ''`
 * and additionally `fromAccount`, `toAccount`; a bill's row has neither.
 *
 * @param {object} [input]
 * @param {any[]} [input.budgetItems]
 * @param {any[]} [input.envelopes]
 * @param {any[]} [input.transactions]
 * @param {Date} [input.today]  required in practice — see `requireClock`
 * @param {any[]} [input.tombstones]
 * @param {string | null} [input.envelopeId]
 * @param {string} [input.country]
 * @param {any[]} [input.accounts]  enables the account check above
 */
export function findUnlinkedScheduledPayments({
  budgetItems = [], envelopes = [], transactions = [], today,
  tombstones = [], envelopeId = null, country = 'FI', accounts,
} = {}) {
  const base = requireClock(today, 'findUnlinkedScheduledPayments');
  const todayStr = ymd(base);
  // Same test as materializeDueBudgetItems: the account exists (archived
  // accounts still post, so they still count).
  const accountIds = Array.isArray(accounts)
    ? new Set(accounts.filter(a => a && a.id).map(a => a.id))
    : null;
  const accountOk = (id) => !accountIds || (!!id && accountIds.has(id));

  const envById = new Map();
  for (const env of envelopes || []) {
    if (env && env.id && !env.archived) envById.set(env.id, env);
  }

  const settled = new Set();
  for (const tx of transactions || []) {
    if (tx && typeof tx.from_budget === 'string' && tx.from_budget) settled.add(tx.from_budget);
  }
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) settled.add(k);
  }

  const items = (budgetItems || []).filter(it => it
    && it.as_schedule
    && it.kind !== 'income'
    && it.kind !== 'investment_transfer'
    && it.kind !== 'account_transfer'
    && it.include !== false
    && it.envelope_id
    && envById.has(it.envelope_id)
    && accountOk(it.account_id)
    && (!envelopeId || it.envelope_id === envelopeId));
  const transferItems = envelopeId ? [] : (budgetItems || []).filter(it => it
    && it.as_schedule
    && it.kind === 'account_transfer'
    && it.include !== false
    && it.account_id
    && it.to_account_id
    && it.account_id !== it.to_account_id
    && accountOk(it.account_id)
    && accountOk(it.to_account_id));
  if (items.length === 0 && transferItems.length === 0) return [];

  // One untagged-outflow scan per envelope, shared by that envelope's items.
  const loanLinks = loanItemsByLoanAccount(budgetItems);
  const poolByEnvelope = new Map();
  const poolFor = (envId, fromStr) => {
    const cacheKey = `${envId}|${fromStr}`;
    if (!poolByEnvelope.has(cacheKey)) {
      poolByEnvelope.set(cacheKey, untaggedOutflowRows({
        envelopeId: envId, transactions, fromStr, toStr: todayStr, loanLinks,
      }).filter(row => row.id));
    }
    return poolByEnvelope.get(cacheKey);
  };
  const poolByRoute = new Map();
  const transferPoolFor = (item, fromStr) => {
    const cacheKey = `${item.account_id}|${item.to_account_id}|${fromStr}`;
    if (!poolByRoute.has(cacheKey)) {
      poolByRoute.set(cacheKey, untaggedTransferRows({
        fromAccount: item.account_id, toAccount: item.to_account_id,
        transactions, fromStr, toStr: todayStr,
      }).filter(row => row.id));
    }
    return poolByRoute.get(cacheKey);
  };

  // Pass 1 — every (occurrence, payment) pair that could plausibly be a match.
  const pairs = [];
  const candidates = items.map(item => ({ item, isTransfer: false }))
    .concat(transferItems.map(item => ({ item, isTransfer: true })));
  for (const { item, isTransfer } of candidates) {
    const win = dueOccurrenceWindow(item.as_schedule_since, base);
    const from = win.fromStr;
    // Candidates may land BEFORE the window start (a bill paid early), so the
    // pool reaches back a further `LINK_DAY_WINDOW` days than the occurrences do.
    const poolFrom = ymd(new Date(
      Date.parse(`${from}T00:00:00Z`) - LINK_DAY_WINDOW * 86400000,
    ));
    const pool = isTransfer ? transferPoolFor(item, poolFrom) : poolFor(item.envelope_id, poolFrom);
    if (pool.length === 0) continue;

    const occOpts = { dayType: item.schedule_day_type, country };
    for (const occ of computeScheduledOccurrences(item, from, todayStr, occOpts)) {
      if (!win.owns(occ)) continue;
      // Nothing can have settled a bill that has not landed yet.
      if (occ.date > todayStr) continue;
      const key = `${item.id}:${occ.monthKey}`;
      if (settled.has(key)) continue;
      const dueAmount = round2(Math.abs(occ.amount));
      const found = [];
      for (const row of pool) {
        if (!settles(row, { date: occ.date, amount: dueAmount, itemId: item.id })) continue;
        found.push({ key, item, isTransfer, occ, dueAmount, row });
      }
      // A payment linked to this item is THE payment: amount look-alikes are
      // not rivals for it, so they cannot make the pairing ambiguous (which
      // would leave the occurrence free to post a duplicate).
      const linked = found.filter(p => p.row.itemId);
      pairs.push(...(linked.length ? onePaymentPerDay(linked) : found));
    }
  }
  if (pairs.length === 0) return [];

  // Pass 2 — keep only the mutually unique pairings.
  const occCount = new Map();
  const txCount = new Map();
  for (const p of pairs) {
    occCount.set(p.key, (occCount.get(p.key) || 0) + 1);
    txCount.set(p.row.id, (txCount.get(p.row.id) || 0) + 1);
  }

  const out = [];
  for (const p of pairs) {
    if (occCount.get(p.key) !== 1) continue;
    if (txCount.get(p.row.id) !== 1) continue;
    const env = p.isTransfer ? null : envById.get(p.item.envelope_id);
    const proposal = {
      key: p.key,
      itemId: p.item.id,
      itemDescription: p.item.description || '',
      envelopeId: p.isTransfer ? null : p.item.envelope_id,
      envelopeName: (env && env.name) || '',
      monthKey: p.occ.monthKey,
      dueDate: p.occ.date,
      dueAmount: p.dueAmount,
      txId: p.row.id,
      txDate: p.row.date,
      txPayee: p.row.payee,
      txAmount: round2(p.row.amount),
    };
    if (p.isTransfer) {
      proposal.fromAccount = p.item.account_id;
      proposal.toAccount = p.item.to_account_id;
    }
    out.push(proposal);
  }
  out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return out;
}

/**
 * Reduce each month's planned rows by what the envelope spends in that month,
 * and drop any that net to nothing. "Spends" includes entries dated ahead:
 * a payment typed in now for later in the month, or for a later month.
 *
 * A planned (non-auto-posting) item is recorded by hand, so the `from_budget`
 * dedup that protects scheduled rows cannot fire. The only link back to the
 * item is the optional `budget_item_id` the user picks on the expense (fill
 * %); spend carrying one nets its own item's row and nothing else, see below.
 * Without this netting, an envelope whose bill was entered by hand would be
 * charged twice: once for the transaction the user recorded, once for the
 * plan line on the calendar.
 *
 * Netting against a pool rather than per item, because several items can share
 * one envelope and a hand-recorded expense usually names none of them. Spending
 * is applied to the month's plan in date order until it runs out, which is the
 * ordinary envelope reading: money spent in a month comes off that month's
 * plan. Spend LINKED to an item (`budget_item_id`) is taken out first and nets
 * only that item's row: a bill's row (`forecast_bill`, from
 * `forecastPlannedExpenses`) is settled by any linked payment, a spending
 * item's row is reduced by the amount.
 *
 * Every month with planned rows is netted, from the 1st to the month end,
 * future-dated entries included. This used to net only the start month and
 * only up to today, on the reasoning that "transactions already posted for a
 * future month are real rows the walk picks up on their own". That was the
 * double count: the walk does pick them up, AND the plan row charged again.
 * On the example budget, rent typed in for 3 Oct on 1 Oct took 2,400 out of
 * the envelope in October and made fill % report it short (2026-10-01).
 *
 * A bill paid a few days early often lands in the PREVIOUS month (rent paid
 * 28 Sep for 3 Oct), which a per-month pool cannot see. So before the pools,
 * each planned BILL row (`forecast_bill`) is matched against payments dated
 * in an earlier month with `settles()`, the rule auto-post items use: linked
 * to the row's item at any amount, or unlinked at the exact amount, within
 * the link window. The nearest such payment settles the row and is taken out
 * of its own month's pool, so one payment never nets two months. A payment
 * that settles a bill row of its own month at least as closely stays there.
 * Bills only: a spending item has no "payment for next month", and a
 * groceries purchase on 29 Sep is September's. Fill % (`computeItemFunding`)
 * applies the same look-back.
 *
 * Posted rows carrying `from_budget` are excluded from the pool: those belong
 * to scheduled items and are already handled by key dedup, so counting them
 * here would net the plan down twice over.
 *
 * Exported for `engine/lens.js`, which needs the same netting for the Forecast
 * balance lens. Two preconditions the callers must honour, both learned the
 * hard way here: `plannedRows` must contain ONLY this envelope's rows (a
 * shared pool is consumed by whichever envelope's row sorts first), and the
 * rows must be freshly generated — this mutates `row.amount` in place when a
 * row is partially netted.
 *
 * `poolUsed` is how much of the START month's untagged spend (up to today) a
 * caller has already claimed elsewhere — `projectEnvelopeBalance` passes what
 * `dueUnpostedTotal` consumed for auto-post items. The two guards cover
 * disjoint budget items but read the same transactions, so without this one
 * hand-recorded payment would cancel an auto-post bill AND an unrelated
 * planned row. Callers with no such step leave it at 0.
 *
 * `claimed` is the same idea for the forward netting: the payments
 * `netForecastAgainstRealPaymentsDetailed` spent cancelling auto-post rows.
 * Each comes off the pool of the month it is dated in; only this envelope's
 * unlinked ones count — the rest were never in a pool. Neither they nor
 * `excludeTxIds` (the payments `dueUnpostedTotal` matched to auto-post bills)
 * can settle a planned bill across a month boundary.
 *
 * @param {any[]} plannedRows
 * @param {{ envelopeId: string|null, transactions: any[], startStr: string, poolUsed?: number,
 *   claimed?: ClaimedPayment[], excludeTxIds?: Set<string> | null }} opts
 */
export function netAgainstSpentThisMonth(
  plannedRows, { envelopeId, transactions, startStr, poolUsed = 0, claimed = [], excludeTxIds = null },
) {
  const startMonth = startStr.slice(0, 7);
  /** @type {Map<string, any[]>} */
  const rowsByMonth = new Map();
  for (const r of plannedRows) {
    const ym = String(r.date).slice(0, 7);
    if (ym < startMonth) continue;
    if (!rowsByMonth.has(ym)) rowsByMonth.set(ym, []);
    rowsByMonth.get(ym)?.push(r);
  }
  if (rowsByMonth.size === 0) return plannedRows;

  const months = [...rowsByMonth.keys()].sort();
  const lastMonth = months[months.length - 1];
  const [ly, lm] = lastMonth.split('-').map(Number);
  const spanEnd = ymd(new Date(ly, lm, 0));

  const netted = new Set();
  const byDate = (a, b) => (a.date < b.date ? -1 : 1);

  // One scan over the whole span (plus the link window before it, for bills
  // paid early), bucketed by month: this runs once per envelope per
  // projection, and computeSpareByEnvelope projects them all.
  const startFrom = `${startMonth}-01`;
  const outflows = untaggedOutflowRows({
    envelopeId, transactions, fromStr: shiftDays(startFrom, -LINK_DAY_WINDOW), toStr: spanEnd,
  });

  // ── Bills paid early, across a month boundary ──
  const spokenFor = new Set();
  for (const c of claimed || []) if (c && c.id != null) spokenFor.add(c.id);
  for (const id of excludeTxIds || []) spokenFor.add(id);
  const billRows = [...rowsByMonth.values()].flat().filter(r => r.forecast_bill).sort(byDate);
  const occOf = r => ({ date: r.date, amount: r.amount, itemId: r.forecast_budget_item_id || null });
  const gapOf = (pay, r) => Math.abs(dateDiffDays(pay.date, r.date));
  const usedAcross = new Set();
  for (const row of billRows) {
    const rowMonth = String(row.date).slice(0, 7);
    let best = null;
    let bestRank = Infinity;
    for (const pay of outflows) {
      if (usedAcross.has(pay)) continue;
      if (pay.id != null && spokenFor.has(pay.id)) continue;
      const payMonth = pay.date.slice(0, 7);
      if (payMonth >= rowMonth) continue;
      if (!settles(pay, occOf(row))) continue;
      const gap = gapOf(pay, row);
      // A bill of the payment's own month it settles at least as closely
      // keeps it: that is the nearer occurrence.
      if (billRows.some(o => o !== row && String(o.date).slice(0, 7) === payMonth
        && settles(pay, occOf(o)) && gapOf(pay, o) <= gap)) continue;
      // Linked beats unlinked at any distance, then the nearest wins.
      const rank = (pay.itemId ? 0 : 100000) + gap;
      if (rank < bestRank) { best = pay; bestRank = rank; }
    }
    if (best) {
      usedAcross.add(best);
      netted.add(row);
    }
  }

  /** @type {Map<string, { pool: number, linkedByItem: Map<string, number> }>} */
  const spendByMonth = new Map();
  const bucket = (ym) => {
    let b = spendByMonth.get(ym);
    if (!b) { b = { pool: 0, linkedByItem: new Map() }; spendByMonth.set(ym, b); }
    return b;
  };
  for (const row of outflows) {
    // The look-back is only for the pass above; and a payment it used is
    // spoken for, so it nets nothing in its own month.
    if (row.date < startFrom || usedAcross.has(row)) continue;
    const b = bucket(row.date.slice(0, 7));
    if (row.itemId) b.linkedByItem.set(row.itemId, round2((b.linkedByItem.get(row.itemId) || 0) + row.amount));
    else b.pool = round2(b.pool + row.amount);
  }
  // Claims come off the month they are dated in. `dueUnpostedTotal`'s claims
  // are spend up to today, i.e. the start month.
  bucket(startMonth).pool = round2(bucket(startMonth).pool - (Number.isFinite(poolUsed) ? poolUsed : 0));
  for (const c of claimed || []) {
    if (c && !c.itemId && c.envelopeId === envelopeId && c.date >= `${startMonth}-01` && c.date <= spanEnd) {
      const b = bucket(c.date.slice(0, 7));
      b.pool = round2(b.pool - c.amount);
    }
  }

  const reduce = (r, amount) => {
    const take = Math.min(amount, r.amount);
    const remaining = round2(r.amount - take);
    if (remaining < CENT_EPSILON) netted.add(r);
    else r.amount = remaining;
    return take;
  };

  for (const ym of months) {
    const rowsIn = rowsByMonth.get(ym) || [];
    const spend = spendByMonth.get(ym);
    if (!spend) continue;

    // Linked spend first, and only against its own item: the user said which
    // item a payment was for, so it never nets another item's plan. A bill is
    // settled for the month by any linked payment (an invoice above or below
    // its estimate is still that month's invoice); a spending item's plan is
    // reduced by what was spent. Spend linked to an item with no row here
    // (auto-posted, deleted, or not planned this month) nets nothing.
    for (const [itemId, spent] of spend.linkedByItem) {
      const own = rowsIn.filter(r => r.forecast_budget_item_id === itemId && !netted.has(r)).sort(byDate);
      if (own.length === 0) continue;
      if (own[0].forecast_bill) {
        for (const r of own) netted.add(r);
        continue;
      }
      let left = spent;
      for (const r of own) {
        if (left <= 0) break;
        left = round2(left - reduce(r, left));
      }
    }

    // Unlinked spend: the month's pool, applied in date order.
    let pool = spend.pool;
    for (const row of rowsIn.filter(r => !netted.has(r)).sort(byDate)) {
      if (pool <= 0) break;
      pool = round2(pool - reduce(row, pool));
    }
  }

  return netted.size === 0 ? plannedRows : plannedRows.filter(r => !netted.has(r));
}

/**
 * The projection window: a half-open interval [start, start + months).
 *
 * Ending ON the anniversary date would open a 13th one-day month bucket for a
 * start on the 1st, so the last day is the anniversary minus one. `endStr`
 * also bounds event gathering, so it has to be the same date the walk stops
 * at — otherwise events land in the window that the walk never applies.
 */
function resolveWindow(today, months) {
  const base = requireClock(today, 'projectEnvelopeBalance');
  // At least one month: `months <= 0` used to give a one-day window, whose
  // flat series reads exactly like a healthy envelope to every rule.
  const span = Number.isFinite(months) ? Math.max(1, Math.trunc(months)) : 12;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());

  // Clamp the anniversary day to the target month's length rather than letting
  // Date overflow roll it forward: `new Date(2026, 1, 31)` is 2026-03-03, which
  // would run a `months: 1` window from the 31st into a third month bucket.
  const targetMonth = start.getMonth() + span;
  const lastDayOfTarget = new Date(start.getFullYear(), targetMonth + 1, 0).getDate();
  const day = Math.min(start.getDate(), lastDayOfTarget);
  const end = new Date(start.getFullYear(), targetMonth, day - 1);

  return { start, startStr: ymd(start), endStr: ymd(end) };
}

/**
 * Merge every event source into one date-sorted list of typed effects on this
 * envelope, and resolve the monthly-fill plan while the deduped forecast fills
 * are in hand.
 *
 * Returns { events, fillPlan }.
 *
 * @param {object} input
 * @param {string} input.envelopeId
 * @param {any[]} input.transactions
 * @param {any[]} input.budgetItems
 * @param {any[]} input.envelopeTemplates
 * @param {any[]} input.accounts
 * @param {any[]} input.envelopes
 * @param {any} input.window
 * @param {number} [input.months]
 * @param {string} [input.country]
 * @param {any[]} input.injections
 * @param {number} [input.spentPoolUsed]
 * @param {Set<string> | null} [input.dueClaimedTxIds]  ids already claimed by
 *   `dueUnpostedTotal`, so the planned-row netting cannot spend them twice
 * @param {any[]} [input.tombstones]  occurrence keys the user deleted
 * @param {any[]} [input.dueAhead]  owned occurrences whose payment is still
 *   ahead, from `dueUnpostedTotal`
 * @param {((row: any, targetId: string) => number) | null} [input.setDrawFor]
 *   resolves one set line's delta for a `source_set_pending` row this
 *   envelope funds
 */
function gatherEvents({
  envelopeId, transactions, budgetItems, envelopeTemplates, accounts,
  envelopes, window, months, country, injections, spentPoolUsed = 0,
  dueClaimedTxIds = null, tombstones = [], dueAhead = [], setDrawFor = null,
}) {
  const { start, startStr, endStr } = window;

  // 1. Real transactions dated after today (posted and scheduled alike).
  const realFuture = (transactions || []).filter(tx => {
    if (!tx || tx.is_forecast) return false;
    const d = dayOf(tx);
    return d > startStr && d <= endStr;
  });

  // 2 + 3. Forecast legs, deduped against occurrences already posted — and
  // against the ones the user deleted, which the materialisers treat as
  // posted and so will never write.
  const taken = new Set();
  for (const tx of transactions || []) {
    if (tx && typeof tx.from_budget === 'string') taken.add(tx.from_budget);
  }
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) taken.add(k);
  }
  const scheduled = netForecastAgainstRealPaymentsDetailed(
    [
      ...dueAhead,
      // The same owned-but-unpaid gap for the kinds `dueUnpostedTotal` does
      // not cover (an investment buy debits its envelope too). Its expense
      // rows are `dueAhead` already, gated and netted there.
      // A loan payment's legs are left out for the same reason: the item is
      // expense-shaped here, so `dueAhead` already carries its whole payment.
      ...forecastDueAheadTransactions(budgetItems, accounts, envelopes, start, { country, transactions })
        .filter(r => r.type !== 'expense' && !r.forecast_loan_leg),
      ...forecastScheduledTransactions(
        budgetItems, accounts, envelopes, start, endStr, null, country, { transactions },
      ),
    ],
    {
      transactions,
      windowFromStr: startStr,
      windowToStr: endStr,
      excludeTxIds: dueClaimedTxIds,
    },
  );
  const forecastExpenses = projectPlannedSpending([
    // The forward half of `dueUnpostedTotal`'s netting: a bill the user has
    // already entered by hand must not be charged twice because nothing
    // stamped it with a `from_budget` key.
    //
    // The pool reaches a match window back BEFORE today, which catches the
    // bill paid early — occurrence still ahead, payment already inside
    // `opening`. `dueUnpostedTotal` covers only occurrences dated today or
    // earlier, so without this that pairing is nobody's job. Reaching back is
    // only safe because `claimedTxIds` names the rows it already spent: both
    // passes read the same transactions, and one payment may settle one
    // occurrence. `dueAhead` rides along: those are owned occurrences whose
    // payment is still ahead, and a hand payment can settle them too.
    ...scheduled.rows,
    // Planned-but-not-auto-posted spend. Most budget items are this: they have
    // a monthly_schedule and get recorded by hand. Leaving them out makes an
    // envelope funded for exactly that spending look permanently over-funded.
    //
    // Scoped to THIS envelope's own items before netting. `netAgainstSpentThisMonth`
    // nets a single pool (this envelope's actual spend so far) against a
    // date-sorted list of rows; fed every envelope's planned rows, the pool
    // was consumed by whichever envelope's row happened to sort first (ties
    // broken by budget-item order) instead of this envelope's own, so a
    // household's Groceries/Food & Drinks rows — both month-end, both early in
    // the item list — silently absorbed every other same-day envelope's
    // netting pool and left its own row un-netted, doubling the projected
    // outflow for the rest of the month. Every other envelope's own row is
    // irrelevant here regardless: it is dropped downstream by the per-envelope
    // effect filter the moment this function returns, so scoping it earlier
    // costs nothing.
    //
    // `claimed`: a payment that just cancelled a scheduled row above is spoken
    // for, exactly as `spentPoolUsed` is for `dueUnpostedTotal`'s claims.
    ...netAgainstSpentThisMonth(
      forecastPlannedExpenses(
        budgetItems.filter(item => item && item.envelope_id === envelopeId),
        accounts, envelopes, start, endStr, { country, monthlyBuckets: true },
      ),
      {
        envelopeId, transactions, startStr, poolUsed: spentPoolUsed, claimed: scheduled.claimed,
        excludeTxIds: dueClaimedTxIds,
      },
    ),
  ].filter(f => !taken.has(forecastKey(f))), { today: start, end: endStr });
  const forecastFills = [
    // A template fill whose schedule date has passed but whose working-day
    // shift pays it after today: the materialiser owns it and will not write
    // it yet, and `forecastAllFills` starts at tomorrow's schedule date.
    ...forecastDueAheadTemplateFills(envelopeTemplates, budgetItems, envelopes, start, { country }),
    ...forecastAllFills(
      budgetItems, envelopeTemplates, accounts, envelopes, start, endStr, { country },
    ),
  ]
    .filter(f => !taken.has(forecastKey(f)))
    // A set-mode fill this envelope FUNDS: its source line so far carries only
    // the add part. Resolve it to the delta the target's walk applies, before
    // the fill plan reads it — the draw is this envelope's scheduled drain.
    .map(f => (setDrawFor && f.source_set_pending && f.source_envelope_id === envelopeId
      ? resolvePendingSetRow(f, l => setDrawFor(f, l.envelope_id))
      : f));

  const fillPlan = resolveMonthlyFill({
    envelopeId, forecastFills, transactions, today: start, months, endStr,
  });

  // Same-day ordering contract. Events landing on one day are applied in
  // concat order, pinned by `order: i` through the sort below:
  //
  //   real → forecast expense → forecast fill → synthetic fill → injection
  //
  // This is load-bearing, not incidental. A `set`-mode fill overwrites the
  // running balance, so whether it lands before or after a same-day expense
  // decides whether that expense survives at all — expenses first means the
  // set value is what the envelope actually holds at the end of the day.
  // Injections last is what the recommendation bisection depends on: a
  // hypothetical top-up must apply on top of everything else that day,
  // including a `set` fill that would otherwise erase it.
  const allEvents = [
    ...realFuture,
    ...forecastExpenses,
    ...forecastFills,
    ...fillPlan.syntheticFills,
    ...injections,
  ];

  // Keep only the events that touch this envelope, resolving each to a typed
  // effect once so the walk itself stays cheap.
  const events = [];
  allEvents.forEach((tx, i) => {
    const effect = txEnvelopeEffect(tx, envelopeId);
    if (!effect) return;
    events.push({ date: dayOf(tx), tx, effect, order: i });
  });
  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));

  return { events, fillPlan };
}

/**
 * Walk the window one day at a time, applying each day's effects and replaying
 * the month-end rollover policy, into a daily balance series and month buckets.
 *
 * A `set` effect overwrites the balance walked to so far, so a forecast set
 * line resolves here, against the day it lands on: its delta is
 * `target − walked balance` (negative when the envelope holds more). Each
 * forecast set's delta is recorded in `setDeltas` for the funding side.
 *
 * @param {any[]} events
 * @param {number} opening
 * @param {any} window
 * @param {string} rollover
 * @param {number} fillDelta
 * @param {string} [envelopeId]  keys `setDeltas`
 * @param {number} [ownOpening]
 * @param {any[]} [openingEffects]
 * @returns {{ daily: {date: string, balance: number}[], months: any[], setDeltas: Map<string, number> }}
 */
function walkDays(events, opening, window, rollover, fillDelta, envelopeId = '', ownOpening = opening, openingEffects = []) {
  const { start, startStr, endStr } = window;

  // `fillDelta` is a per-calendar-month amount, so it has to be split across
  // that month's fills before the walk can apply it. A non-finite delta means
  // a malformed bisection step; treat it as no change rather than letting NaN
  // or a round2'd Infinity silently zero every fill.
  const monthlyDelta = Number.isFinite(fillDelta) ? Number(fillDelta) : 0;
  const fillShares = monthlyDelta ? fillShareByMonth(events, monthlyDelta) : null;

  // Day zero is the window start, and it collects every event dated on OR
  // before it. Real rows cannot be here (`realFuture` starts tomorrow), but a
  // generated one can: generators own an occurrence by its SCHEDULE date from
  // tomorrow on, and a prev_work_day shift can move the payment onto today or
  // earlier — a bill on Saturday the 31st pays Friday the 30th. Nothing else
  // counts that row (`dueUnpostedTotal` owns only schedule dates up to today,
  // and post-due will not write it until its schedule date arrives), so it is
  // applied here, once. When post-due does write it, key dedup drops the
  // generated twin.
  const byDate = new Map();
  for (const ev of events) {
    const d = ev.date < startStr ? startStr : ev.date;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(ev);
  }

  let bal = opening;
  // The month's own balance, without next month's fills dated in it, and
  // those fills' effects: the month-end rollover acts on the former and
  // replays the latter (policies.js `rolloverDelta`).
  let pre = ownOpening;
  /** @type {any[]} */
  let earlyEffects = [...openingEffects];
  const daily = [];
  const monthMap = new Map();
  /** @type {Map<string, number>} */
  const setDeltas = new Map();

  // Walk from the start day itself, not the day after: day zero applies its
  // own events and, when today is the last day of a month, today's month-end
  // rollover. Starting at tomorrow skipped that rollover entirely, so a
  // cover-from-unallocated envelope sitting at −300 on the 30th stayed at −300
  // for the whole of the next month and was flagged critical.
  const cursor = new Date(start);
  let dstr = startStr;
  // Day zero always runs, even for a window that ends before it starts
  // (`months: 0`): the series is never empty.
  while (dstr === startStr || dstr <= endStr) {
    const key = dstr.slice(0, 7);
    const bucket = touchMonth(monthMap, key, bal, {
      partial: isPartialMonth(key, startStr, endStr),
    });

    for (const ev of byDate.get(dstr) || []) {
      const before = bal;
      const effect = fillShares
        ? applyFillDelta(ev.tx, ev.effect, fillShares.get(ev.date.slice(0, 7)) || null)
        : ev.effect;
      bal = effect.mode === 'set'
        ? round2(effect.value)
        : round2(bal + effect.amount);
      if (isForLaterMonth(ev.tx, key)) earlyEffects.push(txRolloverReplayEffect(ev.tx, envelopeId, effect));
      else pre = effect.mode === 'set' ? round2(effect.value) : round2(pre + effect.amount);
      const delta = round2(bal - before);
      if (effect.mode === 'set' && ev.tx && ev.tx.is_forecast) {
        setDeltas.set(setDrawKey(ev.tx, envelopeId), delta);
      }
      if (delta > 0) bucket.in = round2(bucket.in + delta);
      else if (delta < 0) bucket.out = round2(bucket.out + delta);
    }

    // Month-end rollover, mirroring applyEnvelopeRollovers.
    const isMonthEnd = cursor.getDate()
      === new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    if (isMonthEnd) {
      // A working-day shift can put this month's bill in the next month.
      // Reserve it in the policy calculation, but keep the actual cash event
      // on its payment date. The residual balance covers that later payment.
      let closingPre = pre;
      let closingActual = bal;
      for (const ev of events) {
        const owner = occurrenceMonthOf(ev.tx);
        if (ev.date <= dstr || !owner || owner > key) continue;
        const effect = fillShares
          ? applyFillDelta(ev.tx, ev.effect, fillShares.get(ev.date.slice(0, 7)) || null) : ev.effect;
        closingPre = effect.mode === 'set' ? effect.value : round2(closingPre + effect.amount);
        closingActual = effect.mode === 'set' ? effect.value : round2(closingActual + effect.amount);
      }
      const adj = rolloverDelta(rollover, closingPre, closingActual, earlyEffects);
      if (adj > 0) bucket.in = round2(bucket.in + adj);
      else if (adj < 0) bucket.out = round2(bucket.out + adj);
      bal = round2(bal + adj);
      // Next month starts from here, early fills included.
      pre = bal;
      earlyEffects = [];
    }

    bal = round2(bal);
    daily.push({ date: dstr, balance: bal });
    bucket.low = Math.min(bucket.low, bal);
    bucket.high = Math.max(bucket.high, bal);
    bucket.closing = bal;

    cursor.setDate(cursor.getDate() + 1);
    dstr = ymd(cursor);
  }

  return { daily, months: [...monthMap.values()], setDeltas };
}

/** Extrema over the daily series. */
function summarize(daily) {
  let low = daily[0];
  let high = daily[0];
  let firstNegative = null;
  for (const point of daily) {
    if (point.balance < low.balance) low = point;
    if (point.balance > high.balance) high = point;
    if (!firstNegative && point.balance < -CENT_EPSILON) firstNegative = point;
  }
  return {
    low: { ...low },
    high: { ...high },
    closing: daily[daily.length - 1].balance,
    firstNegative: firstNegative ? { ...firstNegative } : null,
  };
}

// `partial` marks a bucket that does not cover its whole calendar month. A
// window starting mid-month has two of them — the first and the last — and
// that is the normal case, not the exception: only a start on the 1st gives 12
// whole buckets. Consumers must not average across partial buckets as if they
// were full months; the recommendation rules divide by full months only.
function touchMonth(monthMap, key, openingBal, { partial = false } = {}) {
  if (!monthMap.has(key)) {
    monthMap.set(key, {
      key,
      opening: openingBal,
      in: 0,
      out: 0,
      low: openingBal,
      high: openingBal,
      closing: openingBal,
      partial,
    });
  }
  return monthMap.get(key);
}

// A bucket is whole when the window covers day 1 through the month's last day.
function isPartialMonth(key, startStr, endStr) {
  const [y, m] = key.split('-').map(Number);
  const first = `${key}-01`;
  const last = `${key}-${pad(new Date(y, m, 0).getDate())}`;
  return first < startStr || last > endStr;
}

/**
 * Every WHOLE calendar month the window covers, in order. A 12-month window
 * from the 1st has twelve; from any other day it has eleven, with a partial
 * bucket at each end. Used to ask whether a fill schedule funds every month
 * the window can see — the difference between a monthly rate and a cadence
 * that merely happens to include some fills.
 */
function wholeMonthKeys(startStr, endStr) {
  const out = [];
  let [y, m] = startStr.split('-').map(Number);
  const [ey, em] = endStr.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const key = `${y}-${pad(m)}`;
    if (!isPartialMonth(key, startStr, endStr)) out.push(key);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * The shape returned when there is no envelope to project: an empty series
 * carrying `unresolved: true` so callers can tell "nothing to say" apart from
 * "nothing wrong". Only this path sets the flag; a resolved envelope leaves it
 * absent.
 */
/**
 * The shape every projection has. `unresolved` is present only on the bail-out
 * branch, which is what makes it the discriminant: a caller that does not
 * check it reads a flat-zero projection as a perfectly healthy envelope.
 *
 * @typedef {{
 *   envelopeId?: string,
 *   opening: number, dueUnposted?: number, events: any[],
 *   daily: {date: string, balance: number}[], months: any[],
 *   low: {date: string, balance: number}, high: {date: string, balance: number},
 *   closing: number, firstNegative: {date: string, balance: number} | null,
 *   fillSource: string, monthlyFill: number, unresolved?: boolean,
 *   setDeltas?: Map<string, number>, setDraws?: Map<string, number>,
 * }} EnvelopeProjection
 */

/** @returns {EnvelopeProjection} */
function unresolvedProjection(startStr) {
  const point = { date: startStr, balance: 0 };
  return {
    opening: 0,
    events: [],
    daily: [point],
    months: [],
    low: { ...point },
    high: { ...point },
    closing: 0,
    firstNegative: null,
    fillSource: 'none',
    monthlyFill: 0,
    unresolved: true,
  };
}

/**
 * Only a *projected* fill can move. A fill the user has already posted is
 * money that has landed; the recommendation rules cannot retroactively change
 * it, and counting it would also skew the per-month split below.
 */
function isAdjustableFill(tx) {
  return !!tx && tx.type === 'fill' && (tx.is_forecast === true || tx.is_estimate === true);
}

/**
 * The fills `fillDelta` moves: projected fills that put money INTO this
 * envelope (an add line with a positive amount, or a set line).
 *
 * A source envelope's scheduled drains — its lines on a template that funds
 * other envelopes from it (`schedule.source_envelope_id`) — are fills too, with
 * a negative amount. Letting the delta reach them clamped each drain at zero:
 * a raise of 0.01 wiped out a −1700 drain entirely, so the bisection answered
 * "raise the monthly fill by 0.01" for a gap of hundreds, or read an answer off
 * the saturated side ("by 1741, to 41"). A drain is another envelope's fill;
 * "fill this envelope more" does not mean "fund the others less".
 *
 * @param {any} tx
 * @param {any} effect
 */
function isAdjustableInflow(tx, effect) {
  if (!isAdjustableFill(tx) || !effect) return false;
  return effect.mode === 'set' || (Number(effect.amount) || 0) > 0;
}

/**
 * Split a per-month `delta` across each month's adjustable fills, in
 * proportion to their size.
 *
 * `fillDelta` is stated to the user as a monthly figure — "raise the monthly
 * fill by 100". An envelope funded by two income items on one template
 * (bi-weekly or twice-monthly pay, which is common) has two projected fills a
 * month, so adding the delta to each would move 200/month while the label
 * claimed 100. The projection would stay self-consistent and the bisection
 * would still converge — on a number that means something else than it says.
 *
 * §2.10 — the split used to be EVEN, and `applyFillDelta` clamps each fill at
 * zero individually. With unequal fills that loses part of a stated trim: with
 * fills of 1000 and 200 and a stated trim of 1200, each takes −600, the small
 * fill clamps out at 0 having given up only 200, and 800 is removed while the
 * label says 1200. Splitting in proportion to each fill's own size means a
 * trim of the month's whole total takes exactly all of every fill, so nothing
 * is discarded at the clamp.
 *
 * Returns Map<'YYYY-MM', {delta, total, count}> — `applyFillDelta` needs the
 * month's total to work out one fill's share of it, and falls back to an even
 * split when the total is zero (nothing to be proportional to).
 */
function fillShareByMonth(events, delta) {
  const byMonth = new Map();
  for (const ev of events) {
    if (!isAdjustableInflow(ev.tx, ev.effect)) continue;
    const key = String(ev.date).slice(0, 7);
    let slot = byMonth.get(key);
    if (!slot) { slot = { delta, total: 0, count: 0 }; byMonth.set(key, slot); }
    slot.count += 1;
    slot.total += Math.abs(fillMagnitude(ev.effect));
  }
  return byMonth;
}

/** The size of a projected fill, whichever mode it carries. */
function fillMagnitude(effect) {
  if (!effect) return 0;
  return effect.mode === 'set' ? (effect.value || 0) : (effect.amount || 0);
}

/**
 * Apply this month's share of the `fillDelta` knob to one projected fill.
 *
 * Clamped at zero: the trim rule bisects a negative delta upward, and without
 * a floor an oversized trim turns the fill into a withdrawal — so the search
 * would happily converge on trimming more than the fill actually contains.
 */
function applyFillDelta(tx, effect, monthShare) {
  if (!monthShare || !monthShare.delta || !isAdjustableInflow(tx, effect)) return effect;
  const { delta, total, count } = monthShare;
  // Proportional to this fill's own size, so a trim of the month's whole
  // total takes all of every fill and none of it is discarded at the clamp
  // below. With nothing to be proportional to, fall back to an even split.
  const mag = Math.abs(fillMagnitude(effect));
  const share = total > 0 ? delta * (mag / total) : delta / (count || 1);
  if (effect.mode === 'set') return { mode: 'set', value: round2(Math.max(0, effect.value + share)) };
  return { mode: 'add', amount: round2(Math.max(0, effect.amount + share)) };
}

/**
 * Resolve the recurring fill this envelope can expect each month.
 *
 * `amount` is a PER-CALENDAR-MONTH total for this envelope — the sum of every
 * line landing on it in a month, not a per-fill figure. This is the same unit
 * as `projectEnvelopeBalance`'s `fillDelta`, which splits a per-month delta
 * across that month's fills. The two must agree: an envelope funded twice a
 * month (bi-weekly pay) would otherwise be told "raise the fill by X" when the
 * arithmetic behind that advice moved 2X.
 *
 * Preference order:
 *   'scheduled' — a scheduled income item's template already funds it, EVERY
 *                 whole calendar month in the window is funded, and every
 *                 contributing line is add-mode. Only under all three is
 *                 `amount` a true per-calendar-month rate, and only then may
 *                 the rules phrase per-month advice against it.
 *   'scheduled-set'
 *               — every contributing line is `set`-mode: the envelope is
 *                 topped up TO a target on each fill, whatever the cadence.
 *                 `amount` is that target (not a rate), and `fillDelta`
 *                 moves the target, so the rules phrase their advice as
 *                 "raise/lower the top-up target" (2026-09-24; this used to
 *                 be folded into 'scheduled-irregular' and stood down).
 *   'scheduled-irregular'
 *               — scheduled fills exist, but the window has funding gaps
 *                 (quarterly, annual) or add and set lines are mixed.
 *                 `amount` is a best-effort display figure and NOT a rate:
 *                 quarterly funding of 2400 is really 800/month, and a mix
 *                 of a set target and an add amount is neither. The rules
 *                 must not emit `shortfall-monthly` or `overfunded-trim`
 *                 against it — a one-time top-up is the only per-amount
 *                 advice that survives an unknown cadence.
 *   'history'   — no scheduled fill, but the envelope has been filled by hand.
 *                 Use the MEDIAN of the trailing six months (a mean lets one
 *                 onboarding `set` or a catch-up top-up dominate) and inject a
 *                 synthetic monthly fill on the median day-of-month.
 *   'none'      — no signal at all; project no incoming money and let the
 *                 warning rule say so.
 *
 * Synthetic rows carry `is_estimate: true` so the recommendation rules'
 * `fillDelta` knob can move them and the UI can label them.
 */
function resolveMonthlyFill({ envelopeId, forecastFills, transactions, today, months, endStr }) {
  const startStr = ymd(today);

  // Total this envelope receives per calendar month, keyed YYYY-MM. Summing
  // per month (rather than per row) keeps `amount` in the same unit as
  // `fillDelta`: an envelope funded twice a month reports the combined figure.
  const byMonth = new Map();
  let anySetMode = false;
  let anyAddMode = false;
  // The target each month's LAST set line tops up to, keyed YYYY-MM. Rows
  // come per template, not in date order, so sort before reading "last".
  /** @type {Map<string, number>} */
  const setTargetByMonth = new Map();
  const rows = [...forecastFills].sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0));
  for (const row of rows) {
    let sum = 0;
    let rowHasSet = false;
    let rowHasAdd = false;
    let setValue = 0;
    for (const line of row.lines || []) {
      if (line.envelope_id !== envelopeId) continue;
      if (line.mode === 'set') { rowHasSet = true; setValue = line.amount; }
      else rowHasAdd = true;
      sum += line.amount;
    }
    // Keep NEGATIVE sums: the source envelope of a source-funded template
    // fill (schedule.source_envelope_id) is scheduled to be DRAINED every
    // month. `sum <= 0` dropped those rows, classed the envelope as having no
    // scheduled fill, and the history fallback below then abs-summed its own
    // posted drain lines into a synthetic +fill that exactly cancelled the
    // drawdown — a Salary Buffer that never depleted in the health view
    // (2026-08 audit review). A negative monthly fill is real information:
    // "this envelope is scheduled to lose N per month".
    if (sum === 0) continue;
    // A `set` line does not ADD its amount, it overwrites the balance, so
    // summing it as if it contributed that much per month is a category error.
    if (rowHasSet) anySetMode = true;
    if (rowHasAdd) anyAddMode = true;
    const key = String(row.date).slice(0, 7);
    byMonth.set(key, round2((byMonth.get(key) || 0) + sum));
    if (rowHasSet) setTargetByMonth.set(key, round2(setValue));
  }

  // The test is whether *this* envelope is scheduled to be filled, not whether
  // any fill is scheduled: a template funding only other envelopes leaves this
  // one on the history fallback.
  if (byMonth.size) {
    // Read the figure off the first WHOLE month — never a PARTIAL one, at
    // either end. The window opens mid-month, so the start month holds only
    // the fills still ahead of today (none at all once the pay day has passed,
    // and only the later of two for a twice-monthly schedule) and the trailing
    // month holds only the fills before the window shuts. Excluding just the
    // start month, as `k > startMonth` did, still lets the TRAILING partial be
    // selected: an annual bonus landing there reported itself as the monthly
    // fill. `monthlyFill` is what the recommendations are phrased against
    // ("raise the monthly fill to X"), so a bucket read off a fraction of a
    // month is a wrong number shown to the user, not an internal inaccuracy.
    const wholeKeys = wholeMonthKeys(startStr, endStr);
    const keys = [...byMonth.keys()].sort();
    const pick = keys.find(k => !isPartialMonth(k, startStr, endStr));

    // Every contributing line sets: the envelope is topped up TO a target.
    // `amount` is that target, and cadence gaps do not matter — raising a
    // target by X raises the balance after every top-up by X, however many a
    // year there are. `fillDelta` already means exactly that on a set line
    // (`applyFillDelta` shifts its value), so the rules can phrase advice as
    // a target change. A mix of add and set lines has no such reading and
    // stays irregular below.
    if (anySetMode && !anyAddMode) {
      const setKeys = [...setTargetByMonth.keys()].sort();
      const setPick = setKeys.find(k => !isPartialMonth(k, startStr, endStr)) || setKeys[0];
      return { source: 'scheduled-set', amount: setTargetByMonth.get(setPick) || 0, syntheticFills: [] };
    }

    // `amount` is a per-calendar-month RATE only when the window has whole
    // months and every one of them is funded. With a gap — quarterly, annual,
    // seasonal — the funded months overstate the rate while `fillDelta`
    // understates its own effect by the same factor, in the opposite
    // direction, which is why neither side of the projection ever notices.
    const gap = wholeKeys.length === 0 || wholeKeys.some(k => !byMonth.has(k));
    const source = (gap || anySetMode) ? 'scheduled-irregular' : 'scheduled';
    // With no whole month funded there is no monthly figure to report at all;
    // 0 alongside an `irregular` source is honest where the bonus amount is not.
    return { source, amount: pick ? byMonth.get(pick) : 0, syntheticFills: [] };
  }

  const since = ymd(new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()));
  const todayStr = startStr;

  // §2.8 — median the trailing six MONTHS, not the individual fill rows.
  //
  // `amount` is documented above as a PER-CALENDAR-MONTH total, and
  // `projectEnvelopeBalance`'s `fillDelta` depends on the two agreeing. This
  // fallback used to push one sample per fill TRANSACTION and call the median
  // a monthly rate. On an envelope hand-filled sparsely — three fills across
  // six months — that yields a healthy positive median and synthesises twelve
  // monthly fills the owner has no intention of making. The projection then
  // never dips, `low` and `spare` are both too high, and the recommendation
  // engine can advise TRIMMING an envelope that is actually short.
  //
  // The scheduled branch thirty lines above already buckets into `byMonth`
  // first, with a comment saying exactly why. Only this fallback skipped it.
  //
  // Seeding all six keys to zero is the load-bearing half: an unfunded month
  // must contribute a ZERO sample, not be absent. Three fills in one month and
  // nothing in the other five is a median of 0, which the positive-median
  // guard below then correctly declines to extrapolate.
  const monthBuckets = new Map();
  for (let i = 6; i >= 1; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
    monthBuckets.set(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, 0);
  }

  const days = [];
  let sawFill = false;
  for (const tx of transactions || []) {
    if (!tx || tx.type !== 'fill' || tx.is_forecast) continue;
    const d = dayOf(tx);
    if (d < since || d > todayStr) continue;
    let sum = 0;
    let hit = false;
    for (const line of tx.lines || []) {
      if (line.envelope_id !== envelopeId) continue;
      hit = true;
      // SIGNED, not Math.abs: the source envelope's posted drain lines are
      // negative. Abs-summing them read a -4 023.86 monthly drain as a
      // +4 023.86 historical hand fill and synthesised a refill that
      // cancelled the drawdown (2026-08 audit review).
      sum += Number(line.amount) || 0;
    }
    if (!hit || sum === 0) continue;
    sawFill = true;
    const key = d.slice(0, 7);
    // A fill inside the six-month window but outside the six whole-month keys
    // (the window opens mid-month) still proves the envelope is hand-filled;
    // it just has no bucket of its own to sum into.
    if (monthBuckets.has(key)) monthBuckets.set(key, round2(monthBuckets.get(key) + sum));
    // Only months that actually had a fill carry a day-of-month; a zero month
    // has none, so it must not drag the synthesised fill day toward the 1st.
    days.push(Number(d.slice(8, 10)));
  }

  if (!sawFill) {
    return { source: 'none', amount: 0, syntheticFills: [] };
  }

  const amount = median([...monthBuckets.values()]);
  // Only a POSITIVE median is a fill pattern worth extrapolating. A negative
  // or zero one means the hand activity has been net outflow — synthesising
  // monthly refills from it would invert reality.
  if (amount <= 0) {
    return { source: 'none', amount: 0, syntheticFills: [] };
  }
  const day = Math.round(median(days));
  const syntheticFills = [];
  // Start at i = 0, not 1: when today is early in the month, THIS month's fill
  // has not landed yet and the projection must include it. Dates on or before
  // today are skipped instead — that fill has already happened and is in the
  // opening balance.
  //
  // Unless it has ALREADY landed, earlier than the usual day: a hand fill on
  // the 2nd when the median day is the 25th. That money is in the opening
  // balance too, and a synthetic fill on the 25th funded the month twice — a
  // projection high by a whole fill, which can turn into advice to trim.
  const thisMonthKey = startStr.slice(0, 7);
  const thisMonthFunded = (monthBuckets.get(thisMonthKey) || 0) >= amount - CENT_EPSILON;
  for (let i = thisMonthFunded ? 1 : 0; i <= months; i++) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const date = ymd(new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(day, lastDay)));
    if (date <= startStr) continue;
    if (date > endStr) break;
    syntheticFills.push({
      id: `estimate:${envelopeId}:${date}`,
      is_estimate: true,
      type: 'fill',
      date,
      status: 'scheduled',
      source: 'estimate',
      lines: [{ envelope_id: envelopeId, mode: 'add', amount }],
      payee: 'Estimated fill',
      note: null,
    });
  }

  return { source: 'history', amount, syntheticFills };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? round2(sorted[mid])
    : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Recommendations ────────────────────────────────────────────────────────


const MAX_BISECTIONS = 12;

/**
 * Smallest x in [0, hi] for which `test(x)` holds, assuming test is monotone in
 * x. Returns null when even `hi` fails — which happens for real: a `set`-mode
 * fill overwrites the balance, so more money upstream changes nothing.
 *
 * Bisects a bounded number of times, then rounds up to a whole currency unit
 * and re-verifies, because rounding down could land just under the target.
 */
function solveMinimum(test, hi) {
  if (hi <= 0) return null;
  if (!test(hi)) return null;
  if (test(0)) return 0;

  let lo = 0;
  let best = hi;
  for (let i = 0; i < MAX_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid)) { best = mid; hi = mid; }
    else           { lo = mid; }
  }
  const rounded = Math.ceil(best);
  if (!test(rounded)) return rounded + 1;
  // The bisection lands just ABOVE the true answer as often as just below, so
  // `Math.ceil` on a `best` of 100.0000001 returns 101 where 100 is exact and
  // verifiable. Step back one unit and keep it if it still holds.
  if (rounded - 1 > 0 && test(rounded - 1)) return rounded - 1;
  return rounded;
}

/**
 * Largest x in [0, hi] for which `test(x)` still holds — the mirror of
 * `solveMinimum`, used for trims. Rounds DOWN, so a trim never overshoots into
 * the cushion it is meant to preserve.
 */
function solveMaximum(test, hi) {
  if (hi <= 0) return null;
  if (!test(0)) return null;

  // There is deliberately no `if (test(hi)) return hi` shortcut. `test` here is
  // not strictly monotone — an oversized delta clamps the fills at zero, after
  // which the projection stops changing and the predicate SATURATES. A
  // shortcut on `test(hi)` therefore returns the whole search bound whenever
  // the bound is large enough to zero the fills, which is exactly the case
  // where the answer is least trustworthy. Bisecting all the way keeps the
  // result tied to a value the search actually walked up to.
  const bound = hi;
  let lo = 0;
  for (let i = 0; i < MAX_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid)) lo = mid;
    else           hi = mid;
  }
  const rounded = Math.floor(lo);
  // `lo` converges from BELOW, so flooring it loses the last unit whenever the
  // true answer is the bound itself (`lo` reaches 799.8 for an answer of 800).
  // Recover it the same way `solveMinimum` steps back: only on a verified test.
  if (rounded + 1 <= bound && test(rounded + 1)) return rounded + 1;
  return rounded > 0 && test(rounded) ? rounded : null;
}

/** Reserve floor: the summed `extra_buffer` of the envelope's budget items. */
export function envelopeFloor(budgetItems, envelopeId) {
  let floor = 0;
  for (const item of budgetItems || []) {
    if (!item || item.envelope_id !== envelopeId) continue;
    if (item.include === false) continue;
    const buf = Number(item.extra_buffer);
    if (Number.isFinite(buf) && buf > 0) floor += buf;
  }
  return round2(floor);
}

/**
 * Batched "spare" headroom for every live envelope: how much of an unplanned,
 * ad-hoc expense each envelope could absorb right now without ever projecting
 * below its floor through the window, given everything already scheduled.
 *
 * `projection.low` already includes day zero (the opening balance), so an
 * envelope currently below its own floor correctly reports a negative spare
 * rather than silently clamping to zero — that negative number is the size of
 * the hole, which is worth showing rather than hiding.
 *
 * One `projectEnvelopeBalance` walk per envelope: no cheaper shortcut exists
 * because each envelope's event set and floor differ. Budget's `forecast.mjs`
 * computes the equivalent figure for the whole ledger in a single shared walk
 * (`envelopeHeadroom`) — that batching is Budget-specific reporting
 * infrastructure, not part of this engine, so the app pays the per-envelope
 * cost here instead.
 *
 * `coveredDate` answers "short until when": the first day from which the
 * projection stays at or above the floor for the rest of the window. It is
 * null when the envelope is not short, and also when it is still below the
 * floor at the window's end, since no date inside the window covers it.
 * "From which it stays" rather than "the first day back above": a hole that
 * refills and opens again later has not been covered yet.
 *
 * `balanceCoveredDate` answers a different question, about the Booked balance
 * (every entered row, future-dated ones included, and no generated row): when
 * that balance is below zero today, the first day it is back at zero or above
 * once the scheduled rows up to that day exist. Metsäreuna, 2026-09-25: a
 * property-tax bill entered for 6 Oct took Booked to −30.60, and the 1 Oct
 * template fill that pays it is only generated. Null when Booked is not below
 * zero, and when a future-dated Set row makes Booked impossible to rebuild
 * by adding.
 *
 * `only` (a Set of envelope ids), when given, projects just those envelopes.
 * `envelopes` stays the whole set every walk reads (a set-mode template finds
 * its target there, the forecast fills their envelopes): projecting a subset
 * by passing a shorter `envelopes` would change the subset's own figures.
 *
 * Returns Map<envelopeId, { spare, floor, lowDate, coveredDate, balanceCoveredDate, daily }>,
 * `daily` being the projection's own `{ date, balance }` series.
 */
export function computeSpareByEnvelope(input) {
  const { only = null, ...walk } = input || {};
  const { envelopes = [], budgetItems = [] } = walk;
  const out = new Map();
  for (const envelope of envelopes) {
    if (!envelope || envelope.archived) continue;
    if (only && !only.has(envelope.id)) continue;
    const projection = projectEnvelopeBalance({ ...walk, envelopeId: envelope.id });
    const floor = envelopeFloor(budgetItems, envelope.id);
    out.set(envelope.id, {
      spare: round2(projection.low.balance - floor),
      floor,
      lowDate: projection.low.date,
      coveredDate: coveredFrom(projection.daily, floor),
      balanceCoveredDate: bookedCoveredFrom(projection.daily, walk.transactions, envelope.id),
      // The walk itself, for callers that judge dates against it (fill %,
      // js/engine/item-funding.js) without projecting the envelope again.
      daily: projection.daily,
    });
  }
  return out;
}

/**
 * See `balanceCoveredDate` on `computeSpareByEnvelope`. On each day, Booked
 * with that day's generated rows created is the walked balance plus every
 * entered row dated after that day: the walk has already applied the rest.
 *
 * @param {{ date: string, balance: number }[]} daily
 * @param {any[]} transactions
 * @param {string} envelopeId
 * @returns {string | null}
 */
function bookedCoveredFrom(daily, transactions, envelopeId) {
  if (!daily.length) return null;
  const startStr = daily[0].date;
  /** @type {{ date: string, amount: number }[]} */
  const later = [];
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    const d = dayOf(tx);
    if (!(d > startStr)) continue;
    const effect = txEnvelopeEffect(tx, envelopeId);
    if (!effect) continue;
    if (effect.mode !== 'add') return null;
    later.push({ date: d, amount: effect.amount });
  }
  later.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let pending = round2(later.reduce((s, r) => s + r.amount, 0));
  let j = 0;
  for (let i = 0; i < daily.length; i++) {
    const point = daily[i];
    while (j < later.length && later[j].date <= point.date) {
      pending = round2(pending - later[j].amount);
      j++;
    }
    const booked = round2(point.balance + pending);
    if (booked >= -CENT_EPSILON) return i === 0 ? null : point.date;
  }
  return null;
}

/**
 * The day after the last daily point below the floor, or null when no point
 * is below it or the last one is (see `computeSpareByEnvelope`).
 *
 * @param {{ date: string, balance: number }[]} daily
 * @param {number} floor
 * @returns {string | null}
 */
function coveredFrom(daily, floor) {
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].balance < floor - CENT_EPSILON) {
      return i + 1 < daily.length ? daily[i + 1].date : null;
    }
  }
  return null;
}

/** First daily point at or below the floor, or null. */
function firstBelowFloor(daily, floor) {
  for (const point of daily) {
    if (point.balance < floor - CENT_EPSILON) return point;
  }
  return null;
}

/**
 * The projected low EXCLUDING day zero — the low the recommendation rules
 * reason over.
 *
 * `daily[0]` is the window start: the OPENING balance plus whatever already
 * lands on today (a generated row shifted back onto it, today's month-end
 * rollover). Nothing a recommendation proposes lands there — every injection
 * is dated after the start — so it cannot move it. So when the opening is below
 * the floor — the normal
 * state of any envelope whose `extra_buffer` reserve is not yet fully funded —
 * a predicate minimising over the full series is unsatisfiable for EVERY
 * candidate, and the solver correctly reports that no amount works. Correct,
 * and useless: the user is told their shortfall cannot be fixed.
 *
 * "You are below your reserve floor today" is a fact to report, not a thing to
 * solve away, so the rules look only at what they can act on. `projection.low`
 * is deliberately left alone — the UI tile still shows the true low.
 *
 * Returns null for a window with no days after the start.
 */
function lowAfterStart(daily) {
  if (!daily || daily.length < 2) return null;
  let low = daily[1];
  for (let i = 2; i < daily.length; i++) {
    if (daily[i].balance < low.balance) low = daily[i];
  }
  return low;
}

/** The day before `dateStr`, as YYYY-MM-DD. */
function dayBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(new Date(y, m - 1, d - 1));
}

/**
 * Whether `projection` was built from `input`: same envelope, same window.
 * The window is recomputed from `input` rather than trusted, because that is
 * the mismatch a caller cannot see — a projection from yesterday's `today`,
 * or a 6-month one handed to 12-month rules.
 *
 * @param {EnvelopeProjection | null} projection
 * @param {any} input
 * @returns {projection is EnvelopeProjection}
 */
function projectionMatches(projection, input) {
  if (!projection || !Array.isArray(projection.daily) || !projection.daily.length) return false;
  if (!input || !input.today) return false;
  if (!projection.unresolved && projection.envelopeId !== input.envelopeId) return false;
  const { startStr, endStr } = resolveWindow(input.today, input.months);
  if (projection.daily[0].date !== startStr) return false;
  // An unresolved projection is a single day-zero point; it has no end.
  return !!projection.unresolved || projection.daily[projection.daily.length - 1].date === endStr;
}

/**
 * Deterministic recommendations for one envelope.
 *
 * `input` is the same object `projectEnvelopeBalance` takes; pass `projection`
 * when you already have one so the base walk is not repeated.
 *
 * Every amount is verified: the rule proposes a candidate, re-projects with it
 * applied, and bisects until the projected low clears the floor. Nothing here
 * relies on the curve shifting uniformly, because with a `set`-mode fill or a
 * `zero-monthly` sweep it does not.
 *
 * Returns [{ kind, severity, amount, date, meta }] ordered critical → info.
 * The engine never formats text; callers map `kind` to a string.
 */
export function recommendEnvelopeActions(input, projection = null) {
  // Reuse the caller's projection only when it was built from this input.
  // Every rule reads `base` for the current state and re-projects `input` for
  // its probes, so a projection of another envelope or another window gave
  // advice whose two halves described different things, with nothing to say so.
  const base = projectionMatches(projection, input) ? projection : projectEnvelopeBalance(input);
  // An unresolved envelope (missing from `envelopes`, or archived) projects a
  // flat zero, and every numeric rule below would read that as "perfectly
  // healthy". Bail before any of them run, and say what is actually wrong.
  if (base.unresolved) {
    return [{ kind: 'warn-unresolved-envelope', severity: 'warn', amount: null, date: null, meta: {} }];
  }
  const { envelopeId, budgetItems = [], envelopes = [] } = input || {};
  const envelope = envelopes.find(e => e && e.id === envelopeId) || null;
  const floor = envelopeFloor(budgetItems, envelopeId);
  const out = [];

  // `monthlyFill` is a per-calendar-month RATE only on the plain `scheduled`
  // source. On `scheduled-irregular` it is a display figure, so every rule
  // phrased "…per month" has to stand down — see `resolveMonthlyFill`.
  const irregularFill = base.fillSource === 'scheduled-irregular';
  // `fillDelta` moves inflows only (`isAdjustableInflow`). With no projected
  // fill INTO this envelope there is nothing for a per-month rule to raise or
  // trim, so they stand down, as on an irregular source. Probing anyway only
  // ever came back unsolvable, which the sheet rendered as "this envelope
  // uses a set-mode fill" whatever the real reason was.
  const hasInflowFill = base.events.some(ev => isAdjustableInflow(ev.tx, ev.effect));
  const noMonthlyLever = irregularFill || !hasInflowFill;
  // The scheduled case needs its own explanation: every projected fill line
  // on it is a drain (it funds other envelopes). `none` already says why with
  // `warn-no-fill`.
  const drainOnly = !irregularFill && !hasInflowFill
    && (base.fillSource === 'scheduled' || base.fillSource === 'scheduled-set');
  // On `scheduled-set` it is the top-up TARGET, and `fillDelta` moves the
  // target, so the same bisections run and the answer is a target change.
  // `fillMode` in each rule's meta tells the caller which phrasing applies.
  const fillMode = base.fillSource === 'scheduled-set' ? 'set' : 'add';

  // Every probe re-projects this envelope. The draws its set-funded sources
  // make depend only on OTHER envelopes' walks, which no probe here moves, so
  // reuse the base projection's instead of re-projecting those every time.
  const probe = base.setDraws && base.setDraws.size ? { ...input, setDraws: base.setDraws } : input;

  const startStr = base.daily[0].date;
  const workLow = lowAfterStart(base.daily) || base.low;
  const short = workLow.balance < floor - CENT_EPSILON;
  if (short) {
    const severity = workLow.balance < -CENT_EPSILON ? 'critical' : 'warn';
    const breach = firstBelowFloor(base.daily.slice(1), floor);
    // Clamp the injection into the window, and past day zero. `dayBefore(breach)`
    // used to fall before the start whenever the breach was on the first walked
    // day, where the walk silently dropped it — and the bisection then verified
    // every candidate against an untouched projection. (Events dated at or
    // before the start now land on day zero, but a top-up belongs on a day the
    // user can still act before, not folded into today.)
    // Landing ON the breach day is fine numerically: `daily` records the
    // END-of-day balance and injections sort last within a day, so a top-up and
    // an expense on the same date both resolve before that day is recorded.
    const prev = breach ? dayBefore(breach.date) : startStr;
    const topupDate = breach ? (prev > startStr ? prev : breach.date) : startStr;
    const gap = round2(floor - workLow.balance);

    const topup = breach ? solveMinimum(
      x => {
        const low = lowAfterStart(projectEnvelopeBalance({
          ...probe,
          injections: [
            ...(input.injections || []),
            {
              id: `candidate:topup:${x}`,
              type: 'fill',
              date: topupDate,
              status: 'scheduled',
              lines: [{ envelope_id: envelopeId, mode: 'add', amount: x }],
            },
          ],
        }).daily);
        return !!low && low.balance >= floor - CENT_EPSILON;
      },
      gap * 4 + 100,
    ) : null;

    out.push({
      kind: 'shortfall-topup',
      severity,
      amount: topup,
      date: topupDate,
      meta: { floor, low: base.low, unsolvable: topup === null },
    });

    // A one-time top-up is meaningful at any cadence, but "raise the monthly
    // fill by X" is not — there is no monthly fill to raise. On a set-funded
    // envelope X raises the top-up target instead (`fillMode: 'set'`); when
    // that cannot help — the low lands before the first top-up — the rule
    // still emits, `unsolvable`, rather than vanishing.
    if (!noMonthlyLever) {
      const monthly = solveMinimum(
        x => {
          const low = lowAfterStart(projectEnvelopeBalance({ ...probe, fillDelta: x }).daily);
          return !!low && low.balance >= floor - CENT_EPSILON;
        },
        gap + 100,
      );
      out.push({
        kind: 'shortfall-monthly',
        severity,
        amount: monthly,
        date: null,
        meta: { floor, currentFill: base.monthlyFill, fillMode, unsolvable: monthly === null },
      });
    }
  }

  // Average over WHOLE months only. A window starting mid-month — which is
  // every day but the 1st — has a partial bucket at each end, and counting
  // those as full months drags the average down and understates the cushion
  // the trim rule is supposed to preserve. Fall back to all buckets only if
  // the window somehow contains no whole month.
  const wholeMonths = base.months.filter(m => !m.partial);
  const forAvg = wholeMonths.length ? wholeMonths : base.months;
  const avgOutflow = forAvg.length
    ? Math.abs(forAvg.reduce((s, m) => s + m.out, 0)) / forAvg.length
    : 0;
  const goalAmount = Number(envelope && envelope.goal_amount);
  const hasGoal = Number.isFinite(goalAmount) && goalAmount > 0;

  // Overfunded: a full year with the low never dropping to within one month's
  // outflow of the floor means money is parked here doing nothing. A goal is a
  // reason to park money, so goal envelopes are exempt.
  if (!short && !hasGoal && !noMonthlyLever && base.low.balance > floor + avgOutflow + CENT_EPSILON) {
    const trim = solveMaximum(
      x => projectEnvelopeBalance({ ...probe, fillDelta: -x }).low.balance
        >= floor + avgOutflow - CENT_EPSILON,
      // Bound the search in FILL units. `x` is a per-month fill delta, but the
      // old bound was `low - floor`, a BALANCE — a 50,000 cushion against an
      // 800 fill searched up to 49,200 and, because oversized deltas clamp the
      // fills at zero and the predicate saturates, returned it: a "trim" that
      // rendered as a new monthly fill of −48,400. Trimming the entire fill is
      // the most that can ever be meant by "fill this envelope less".
      //
      // On a set-funded envelope the whole TARGET is the bound. Lowering a
      // target by x lowers the balance after each top-up by x, not x per
      // month cumulatively, so the balance cushion says nothing about how far
      // it can go — and the low is often day zero, before the first top-up,
      // which no trim can touch: bounding by it capped the advice at the
      // opening balance.
      fillMode === 'set' ? base.monthlyFill : Math.min(base.low.balance - floor, base.monthlyFill),
    );
    if (trim && trim > 0) {
      out.push({
        kind: 'overfunded-trim',
        severity: 'info',
        amount: trim,
        date: null,
        meta: { floor, cushion: round2(avgOutflow), currentFill: base.monthlyFill, fillMode },
      });
    }
  }

  // Goal check.
  if (hasGoal) {
    const goalDate = envelope.goal_date || null;
    const cutoff = goalDate && goalDate <= base.daily[base.daily.length - 1].date
      ? goalDate
      : base.daily[base.daily.length - 1].date;
    const beyondWindow = !!goalDate && goalDate > cutoff;
    const atCutoff = [...base.daily].filter(d => d.date <= cutoff).pop() || base.daily[0];

    if (atCutoff.balance >= goalAmount - CENT_EPSILON) {
      out.push({
        kind: 'goal-on-track',
        severity: 'info',
        amount: null,
        date: goalDate,
        meta: { goalAmount, projected: atCutoff.balance, beyondWindow },
      });
    } else if (noMonthlyLever) {
      // No monthly rate to raise, so the advice is a one-time top-up by the
      // goal date (or the window's end when the goal has none). It lands ON
      // the cutoff day — injections sort last within a day — so a set-mode
      // fill earlier in the window cannot overwrite it, and the amount is
      // what the balance still lacks there.
      const needed = solveMinimum(
        x => {
          const p = projectEnvelopeBalance({
            ...probe,
            injections: [
              ...(input.injections || []),
              {
                id: `candidate:goal-topup:${x}`,
                type: 'fill',
                date: cutoff,
                status: 'scheduled',
                lines: [{ envelope_id: envelopeId, mode: 'add', amount: x }],
              },
            ],
          });
          const point = [...p.daily].filter(d => d.date <= cutoff).pop();
          return !!point && point.balance >= goalAmount - CENT_EPSILON;
        },
        Math.max(round2(goalAmount - atCutoff.balance) * 2, 100),
      );
      out.push({
        kind: 'goal-shortfall',
        severity: 'warn',
        amount: needed,
        date: goalDate,
        meta: {
          goalAmount, projected: atCutoff.balance, beyondWindow, cutoff,
          currentFill: base.monthlyFill, fillMode: 'one-time', unsolvable: needed === null,
        },
      });
    } else {
      const needed = solveMinimum(
        x => {
          const p = projectEnvelopeBalance({ ...probe, fillDelta: x });
          const point = [...p.daily].filter(d => d.date <= cutoff).pop();
          return !!point && point.balance >= goalAmount - CENT_EPSILON;
        },
        Math.max(goalAmount, 100),
      );
      out.push({
        kind: 'goal-shortfall',
        severity: 'warn',
        amount: needed,
        date: goalDate,
        meta: {
          goalAmount, projected: atCutoff.balance, beyondWindow, cutoff,
          currentFill: base.monthlyFill, fillMode, unsolvable: needed === null,
        },
      });
    }
  }

  // Data-quality warnings — the projection is only as good as its inputs.
  if (base.fillSource === 'history') {
    out.push({ kind: 'warn-fill-from-history', severity: 'info', amount: null, date: null,
      meta: { monthlyFill: base.monthlyFill } });
  }
  if (base.fillSource === 'none') {
    out.push({ kind: 'warn-no-fill', severity: 'info', amount: null, date: null, meta: {} });
  }
  // Explains the ABSENCE of the two per-month rules above, so it has to be
  // emitted whenever they were suppressed — otherwise the sheet simply shows
  // less advice with no reason given.
  if (irregularFill) {
    out.push({ kind: 'warn-irregular-fill', severity: 'info', amount: null, date: null,
      meta: { monthlyFill: base.monthlyFill } });
  }
  if (drainOnly) {
    out.push({ kind: 'warn-drain-only-fill', severity: 'info', amount: null, date: null,
      meta: { monthlyFill: base.monthlyFill } });
  }
  // Any BUDGETED expense counts, auto-posting or not. Asking only for
  // `as_schedule` items told a user with a perfectly good quarterly plan that
  // nothing used the envelope, while the projection charged that plan — the
  // warning contradicted the chart beside it.
  const hasPlannedExpense = (budgetItems || []).some(
    i => i && i.envelope_id === envelopeId && i.include !== false
      && i.kind !== 'income' && i.kind !== 'account_transfer' && i.monthly_schedule,
  );
  if (!hasPlannedExpense) {
    out.push({ kind: 'warn-no-scheduled-expenses', severity: 'info', amount: null, date: null, meta: {} });
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}
