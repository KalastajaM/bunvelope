import { spendingProfiles, projectPlannedSpending } from './spending-profile.js';
// js/engine/lens.js — the balance lens: one named seam that resolves a
// display mode into the transaction array every balance function walks.
//
// Bunvelope can show a balance three ways. Before this module they were
// expressed as ad-hoc combinations of `computeAccountBalances`' two optional
// filters (`onlyPosted`, `asOf`), and call sites picked whichever axis the
// author happened to be thinking about — which is how the dashboard KPI and
// the Accounts page ended up reporting different numbers, both labelled as
// the current balance.
//
//   today    — cleared, as of today. What the bank says. Both filters.
//   booked   — everything entered, including future-dated rows. The default,
//              and the historical behaviour of every unfiltered call site.
//   forecast — booked plus generated rows through a horizon.
//
// Call sites choose a NAME, never a combination. `lensTransactions` owns the
// definitions; adding a fourth lens means editing this file and nothing else.
//
// ── Which surfaces follow the lens, and which do not ──────────────────────
//
// The lens does not apply to every number on screen, and the rule for when it
// applies is worth stating once rather than inferring per page:
//
//   1. A BALANCE — what is in this envelope or account — follows the active
//      lens. Envelopes, Accounts, the dashboard hero, the Transactions page's
//      running balances, the Reports page's balance and balance-history
//      cards. All of them read `viewTxs()`, so one envelope reads the same on
//      every page, and switching lens moves all of them together.
//
//   2. A SPEND OR INCOME TOTAL OVER A PERIOD — "spent this month", the
//      category donut, the monthly trend, every Reports aggregate — ignores
//      the lens and counts posted rows only. It reads raw history through
//      `txConsumptionPairs` / `txConsumptionTotal` (balances.js; the
//      envelope-level `txSpendPairs` minus investment transfers), which own
//      the posted-only decision. A scheduled bill is not money spent, and a
//      figure describing a past period must not change because the user
//      switched to Forecast to look at next month.
//
//   3. An "incl. X upcoming" HINT beside a balance is always the Today lens
//      (`todayTxs()`), whatever the active lens is, because the hint is
//      defined as `displayed − cleared`.
//
// The seam between 1 and 2 is the answer to a question the audit left open —
// "reports use the budget lens while the dashboard KPI is posted-only" — and
// it is deliberate: they are answering different questions. What was wrong
// then was that neither was written down and both were re-derived per call
// site. Now each has exactly one implementation to reach for.
//
// Pure functions. No DOM, no I/O, no preference reading — the caller passes
// the lens in. `js/app.js` holds the thin wrapper that reads it from prefs.

import { requireClock } from './_constants.js';
import { filterTransactions } from './balances.js';
import {
  forecastScheduledTransactions,
  forecastAllFills,
  forecastPlannedExpenses,
  forecastDueAheadTransactions,
  forecastDueAheadTemplateFills,
  resolveSetSourceLegs,
  forecastKey,
} from './scheduling.js';
import { netAgainstSpentThisMonth, netForecastAgainstRealPaymentsDetailed } from './envelope-forecast.js';
import { withCardSettlements } from './card-settlement.js';

export const LENS_TODAY = 'today';
export const LENS_BOOKED = 'booked';
export const LENS_FORECAST = 'forecast';

export const LENSES = [LENS_TODAY, LENS_BOOKED, LENS_FORECAST];

// Booked is the default: it is what every unfiltered call site already did,
// so an existing budget reads identically after the lens lands.
export const DEFAULT_LENS = LENS_BOOKED;

// Horizon presets. A custom ISO date (YYYY-MM-DD) is also accepted.
export const HORIZONS = ['eom', '3m', '6m', '12m'];
export const DEFAULT_HORIZON = '3m';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** @type {readonly any[]} */
const EMPTY = Object.freeze([]);

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Coerce anything to a known lens name. Unknown input falls back to Booked. */
export function normalizeLens(value) {
  return LENSES.includes(value) ? value : DEFAULT_LENS;
}

/** Coerce anything to a known horizon preset or a custom ISO date. */
export function normalizeHorizon(value) {
  if (HORIZONS.includes(value)) return value;
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return value;
  return DEFAULT_HORIZON;
}

/**
 * Resolve a horizon to the ISO end date of the forecast window.
 * `eom` is the last day of the current month; `3m`/`6m`/`12m` are that many
 * months out, clamped to the target month's real length (day 0 of the
 * following month). A custom ISO date passes through.
 *
 * @param {string} horizon
 * @param {Date} today  the clock, supplied by the caller — this module reads
 *   no wall clock of its own
 */
export function resolveHorizonDate(horizon, today) {
  const h = normalizeHorizon(horizon);
  if (ISO_DATE_RE.test(h)) return h;
  const y = today.getFullYear();
  const m = today.getMonth();
  if (h === 'eom') return ymd(new Date(y, m + 1, 0));
  const months = Number(h.replace('m', ''));
  // Day 0 of month+months+1 = last day of month+months, so a 31st never
  // overflows into the next month.
  return ymd(new Date(y, m + months + 1, 0));
}

// ─── Memoization ──────────────────────────────────────────────────────────
//
// `computeAccountBalances` / `computeEnvelopeBalances` memoize on the
// *identity* of the transactions array (js/engine/balance-cache.js). If this
// function returned a freshly built array on every call, every downstream
// balance memo would miss on every call — the lens would silently make the
// app slower than it was before. So the resolved array is cached and returned
// by reference for as long as its inputs are unchanged.
//
// A small LRU rather than a WeakMap chain: the cache key spans six references
// plus two strings, and callers legitimately ask for a lens over a
// *hypothetical* transactions array (the before/after preview in Add-tx and
// Edit-tx), so a one-entry cache would thrash between the two.

const CACHE_MAX = 8;
const cache = []; // [{ key: unknown[], value: Transaction[] }], most recent first

function cacheGet(key) {
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i];
    if (entry.key.length !== key.length) continue;
    let match = true;
    for (let j = 0; j < key.length; j++) {
      if (entry.key[j] !== key[j]) { match = false; break; }
    }
    if (match) {
      if (i > 0) { cache.splice(i, 1); cache.unshift(entry); }
      return entry.value;
    }
  }
  return undefined;
}

function cachePut(key, value) {
  cache.unshift({ key, value });
  if (cache.length > CACHE_MAX) cache.length = CACHE_MAX;
  return value;
}

/** Test-only: drop every cached lens array. */
export function _resetLensCache() {
  cache.length = 0;
}

// ─── Which account pays for an envelope ───────────────────────────────────
//
// Planned (non-auto-posting) budget items usually carry no account: naming one
// is optional, and an item may name an account that has since been archived
// or deleted (`plannedExpenseRows` treats those as absent). A forecast expense
// with no account debits its envelope and no account, and since unallocated
// is `accounts − envelopes` that inflates unallocated by the row's full
// amount — money appearing from nowhere in the one figure whose job is to
// reconcile the two sides.
//
// So attribute it from history: the account this envelope's posted expenses
// actually came from. That is a projection of observed behaviour, not
// invented data, and it degrades in a defined order. Where an envelope
// genuinely splits across accounts the modal choice is arbitrary, but only in
// deciding WHICH account shows the outflow — the envelope figures, the
// account total and unallocated are unaffected either way.

/**
 * Resolve the account each envelope's spending should be forecast from.
 *
 * Returns `{ byEnvelope: Map<envelopeId, accountId>, fallback: accountId|null }`.
 * Counts posted expense rows per (envelope, account) and takes the mode.
 * Ties break toward the account appearing first in `accounts`, so the result
 * is stable across renders rather than dependent on transaction order.
 *
 * Archived accounts are not counted: an envelope last paid from a closed
 * account is forecast from the account it is paid from now (its most used
 * active one), or the fallback, not from an account nobody looks at. The
 * same rule `plannedExpenseRows` applies to an item naming an archived
 * account.
 */
export function resolveEnvelopeAccounts(transactions, accounts) {
  const order = new Map();
  (accounts || []).forEach((a, i) => { if (a && a.id && !a.archived) order.set(a.id, i); });

  const perEnvelope = new Map(); // envelopeId -> Map<accountId, count>
  const overall = new Map();     // accountId -> count

  for (const tx of transactions || []) {
    if (!tx || tx.type !== 'expense' || tx.is_forecast) continue;
    if (tx.status && tx.status !== 'posted') continue;
    const acct = tx.account;
    if (!acct || !order.has(acct)) continue;
    overall.set(acct, (overall.get(acct) || 0) + 1);
    // Split expenses touch several envelopes; credit each of them.
    const envIds = Array.isArray(tx.envelope_splits) && tx.envelope_splits.length
      ? tx.envelope_splits.map(sp => sp && sp.envelope_id)
      : [tx.envelope_id];
    for (const envId of envIds) {
      if (!envId || envId === '__none__') continue;
      let counts = perEnvelope.get(envId);
      if (!counts) { counts = new Map(); perEnvelope.set(envId, counts); }
      counts.set(acct, (counts.get(acct) || 0) + 1);
    }
  }

  const mode = (counts) => {
    let best = null;
    let bestN = -1;
    for (const [acct, n] of counts) {
      if (n > bestN || (n === bestN && order.get(acct) < order.get(best))) {
        best = acct; bestN = n;
      }
    }
    return best;
  };

  const byEnvelope = new Map();
  for (const [envId, counts] of perEnvelope) byEnvelope.set(envId, mode(counts));

  // Last resorts: the account that pays for most things, then simply the
  // first account that could hold spending at all.
  const fallback = (overall.size ? mode(overall) : null)
    ?? ((accounts || []).find(a => a && !a.archived && a.type !== 'investment' && a.type !== 'asset' && a.type !== 'loan' && a.type !== 'loan_given')?.id ?? null);

  return { byEnvelope, fallback };
}

// ─── The seam ─────────────────────────────────────────────────────────────

/**
 * Resolve a lens into the transaction array the balance functions should walk.
 *
 * @param {object} source  anything with the shape of `state`: `transactions`,
 *   and for the forecast lens also `budgetItems`, `envelopeTemplates`,
 *   `accounts`, `envelopes`, `meta.country`, `meta.scheduledTombstones`.
 *   Pass `{ ...state, transactions: hypothetical }` to preview a lens over a
 *   candidate array.
 * @param {object} opts  `{ lens, horizon, today, pendingSetSources }`.
 *   `pendingSetSources: true` (Forecast only) leaves sourced set-mode fills
 *   unresolved (`source_set_pending`), for a caller that changes the rows
 *   first and then runs `resolveSetSourceLegs` itself: a what-if scenario
 *   that cuts a plan row changes the balance a later set fill meets.
 *   Such a caller also adds the credit-card settlements itself, last
 *   (`withCardSettlements`, js/engine/card-settlement.js): a card's
 *   settlement is its balance, which the changed rows move.
 * @returns {Array} transactions — the SAME array reference for the booked
 *   lens, and a stable reference across calls for the other two.
 */
export function lensTransactions(source, opts = {}) {
  const txs = (source && source.transactions) || EMPTY;
  const lens = normalizeLens(opts.lens);

  // Identity, deliberately: booked is "everything you entered", which is
  // exactly `state.transactions`. Returning it untouched keeps every
  // downstream memo warm in the default lens.
  if (lens === LENS_BOOKED) return txs;

  // Required for the two lenses that need it, and validated rather than
  // defaulted — see `requireClock`.
  const today = requireClock(opts.today, 'lensTransactions');
  const todayIso = ymd(today);

  if (lens === LENS_TODAY) {
    const key = [txs, LENS_TODAY, todayIso];
    const hit = cacheGet(key);
    if (hit) return hit;
    // The one definition of "today": cleared AND not in the future. Neither
    // filter alone is it — status alone keeps a future-dated manual row (it
    // has no `status`, so it counts as posted), and date alone keeps a
    // scheduled row that has not actually cleared.
    return cachePut(key, filterTransactions(txs, { onlyPosted: true, asOf: todayIso }));
  }

  // ── Forecast ────────────────────────────────────────────────────────────
  //
  // Planned (non-auto-posting) spend IS included. "Does not auto-post" is not
  // "will not happen": an envelope funded €800/month and spent €800/month is
  // flat, and a forecast that only ever adds the fill shows it climbing to
  // €9,600 — a forecast of the funding schedule, not of the envelope. In a
  // typical budget this is the dominant term, not an edge case: 14 of the 15
  // items in the example budget are planned rather than auto-posting.
  //
  // Two things make it safe, both below: every generated row is attributed to
  // an account (see `resolveEnvelopeAccounts`), so accounts and unallocated
  // stay coherent; and the current month's rows are netted against what has
  // already been spent by hand, so recording the grocery run yourself does
  // not get charged twice.
  const budgetItems       = (source && source.budgetItems) || EMPTY;
  const envelopeTemplates = (source && source.envelopeTemplates) || EMPTY;
  const accounts          = (source && source.accounts) || EMPTY;
  const envelopes         = (source && source.envelopes) || EMPTY;
  const country           = (source && source.meta && source.meta.country) || 'FI';
  const tombstones        = (source && source.meta && Array.isArray(source.meta.scheduledTombstones))
    ? source.meta.scheduledTombstones : EMPTY;
  const endIso            = resolveHorizonDate(opts.horizon, today);

  const pendingSetSources = opts.pendingSetSources === true;
  const key = [txs, budgetItems, envelopeTemplates, accounts, envelopes,
    country, tombstones, LENS_FORECAST, todayIso, endIso, pendingSetSources];
  const hit = cacheGet(key);
  if (hit) return hit;

  // The horizon caps BOOKED rows as well as generated ones. Forecast(D) means
  // one thing — the balance as of D — and every row in it is dated on or
  // before D regardless of where it came from. Capping only the generated
  // side would make provenance decide whether a date filter applies: a row
  // dated May 2027 counted because the user typed it, dropped because the app
  // produced it. That is the same defect the lens exists to remove.
  //
  // Consequence, and it is deliberate: at a short horizon Forecast can read
  // LOWER than Booked, because Booked has no date bound at all and a
  // manually entered row dated past the horizon drops out. The horizon
  // control is on screen next to the switcher, which is what explains it.
  const base = filterTransactions(txs, { asOf: endIso });

  // The scheduled leg is netted against payments the user recorded by hand.
  // `taken` below only matches rows the app itself materialized, so without
  // this a bill typed in ahead of its due date is counted twice in every
  // balance this lens produces: once as that transaction, once as the budget
  // item's own occurrence. Same rule the envelope projection uses, and the
  // pool it derives stays inside this window, so every payment it can claim
  // is already in `base` exactly once.
  //
  // The payments it claims are handed on to the planned-row netting: one that
  // just cancelled a bill must not ALSO shrink this month's planned spend, or
  // a single hand payment is netted twice and the balance reads high.
  //
  // The generators start at today's SCHEDULE date. An occurrence scheduled
  // earlier whose working-day shift pays it after today (payment_day 31,
  // next_work_day: Sat Oct 31 pays Mon Nov 2) is owned by the materialiser,
  // which will not write it until it pays — so on Nov 1 it was in neither
  // the booked rows nor the generated ones. The due-ahead helpers return
  // exactly those, through yesterday's schedule date so they cannot overlap
  // the generators; key dedup below still drops them once posted or
  // tombstoned.
  const yesterdayIso = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const scheduled = netForecastAgainstRealPaymentsDetailed(
    forecastDueAheadTransactions(
      budgetItems, accounts, envelopes, today, { throughStr: yesterdayIso, country, transactions: txs, pendingTargetTransfers: true },
    ).filter(r => r.date <= endIso).concat(forecastScheduledTransactions(
      budgetItems, accounts, envelopes, today, endIso, todayIso, country, { transactions: txs, pendingTargetTransfers: true },
    )),
    { transactions: txs, windowFromStr: todayIso, windowToStr: endIso },
  );
  const generated = scheduled.rows.concat(forecastDueAheadTemplateFills(
    envelopeTemplates, budgetItems, envelopes, today, { throughStr: yesterdayIso, country },
  ).filter(r => r.date <= endIso)).concat(forecastAllFills(
    budgetItems, envelopeTemplates, accounts, envelopes, today, endIso,
    { fromDateStr: todayIso, country },
  )).concat(plannedExpenseRows({
    txs, budgetItems, accounts, envelopes, today, todayIso, endIso, country,
    claimed: scheduled.claimed,
  }));

  // Dedup against the real transaction that already settled the same
  // occurrence. `forecastKey` rather than a hand-composed
  // `${item}:${month}`: a fill's key is not that pair (the income-linked one
  // appends `:fill`, a self-scheduled one is namespaced `tpl:` and has no
  // budget item at all), so a hand-built key silently fails to match. On the
  // Transactions list that shows up as a duplicate row; inside a balance it
  // shows up only as a wrong number.
  //
  // Tombstones count as taken: they are occurrences the user deleted (a
  // waived fee), which the materialisers treat as posted and will never
  // write. Forecasting them brought the deleted bill back.
  const taken = new Set();
  for (const tx of txs) {
    if (tx && typeof tx.from_budget === 'string') taken.add(tx.from_budget);
  }
  for (const k of tombstones) {
    if (typeof k === 'string' && k) taken.add(k);
  }
  // Two generators never emit the same key today (they partition on
  // `as_schedule`), but dedup among the generated rows too so that a future
  // generator cannot double-count silently.
  const fresh = [];
  for (const row of generated) {
    const k = forecastKey(row);
    if (k && taken.has(k)) continue;
    if (k) taken.add(k);
    fresh.push(row);
  }

  // Preserve identity when the horizon dropped nothing and nothing was
  // generated, so a wide-horizon forecast shares the balance memo with the
  // booked lens instead of forcing a parallel walk.
  // Cards with a `settledFrom` account are paid off monthly from it
  // (card-settlement.js), after every other row: the settlement is the
  // card's balance. Without such a card the array is returned unchanged.
  const settle = (/** @type {any[]} */ rows) => (pendingSetSources
    ? rows
    : withCardSettlements(accounts, rows, { todayIso, endIso, booked: txs, budgetItems, country }));
  if (!fresh.length) {
    return cachePut(key, settle(base.length === txs.length ? txs : base));
  }
  // A set-mode fill funded from a source envelope draws the delta that lands
  // its target, which depends on the balance that row meets. Generated rows
  // carry a placeholder for it (`source_set_pending`); resolve them against
  // this exact list, in the order the balance functions walk it, so the
  // source falls by what the target rises and the fill stays net-zero.
  const all = base.concat(projectPlannedSpending(fresh, { today, end: endIso,
    profiles: spendingProfiles({ transactions: txs, accounts, envelopes }, today) }));
  return cachePut(key, pendingSetSources ? all : settle(resolveSetSourceLegs(all)));
}

/**
 * Planned-spend rows for the forecast lens: every budget item with a monthly
 * schedule that Bunvelope does not auto-post.
 *
 * Generated one envelope at a time, which is load-bearing rather than tidy.
 * `netAgainstSpentThisMonth` consumes one pool per month — this envelope's
 * spend in that month, entries dated ahead included — against a date-sorted
 * list of rows. Fed every
 * envelope's rows at once, the pool goes to whichever row sorts first
 * regardless of which envelope it belongs to, so a month-end envelope early
 * in the item list absorbs everyone else's netting and leaves its own row
 * un-netted. `envelope-forecast.js` documents that bug at the call site it
 * was found in; this is the same trap.
 */
function plannedExpenseRows({ txs, budgetItems, accounts, envelopes, today, todayIso, endIso, country, claimed = /** @type {import('./envelope-forecast.js').ClaimedPayment[]} */ ([]) }) {
  const envIds = [];
  const seen = new Set();
  for (const item of budgetItems) {
    if (!item || item.as_schedule || !item.monthly_schedule) continue;
    const envelopeId = item.envelope_id || null;
    if (seen.has(envelopeId)) continue;
    seen.add(envelopeId);
    envIds.push(envelopeId);
  }
  if (!envIds.length) return EMPTY;


  // Accounts a planned item may name and still be charged. An item pointing at
  // an account that was archived or deleted since falls back to the history
  // profile expansion after occurrence deduplication instead.
  const liveAccountIds = new Set();
  for (const a of accounts || []) if (a && a.id && !a.archived) liveAccountIds.add(a.id);
  const out = [];
  for (const envelopeId of envIds) {
    const rows = forecastPlannedExpenses(
      budgetItems.filter(item => item && (item.envelope_id || null) === envelopeId),
      accounts, envelopes, today, endIso, { fromDateStr: todayIso, country, monthlyBuckets: true },
    );
    const netted = netAgainstSpentThisMonth(rows, { envelopeId, transactions: txs, startStr: todayIso, claimed });
    for (const row of netted) {
      // `forecastPlannedExpenses` carries the item's account only while it is
      // live, else null. Honour it; unknown/archived accounts use the profile
      // expansion after deduplication. Recheck liveness as a backstop.
      if (!row.account || !liveAccountIds.has(row.account)) {
        row.account = null;
      }
      out.push(row);
    }
  }
  return out;
}
