// js/engine/policies.js — envelope-level policy and classification helpers:
// frequency bucketing for dashboard grouping, per-month rollover policy
// adjustments, and savings-goal progress.
//
// Pure functions. No DOM, no I/O.

import { round2, wholeDaysBetween } from '../utils.js';
import { MONTH_NAMES, CENT_EPSILON, requireClock } from './_constants.js';
import { computeEnvelopeBalances, txRolloverReplayEffect } from './balances.js';

// ─── Frequency classification (for dashboard grouping) ───────────────────────

/**
 * Classify an envelope into a frequency bucket. Pure function.
 *
 * Uses the union of its budget items' active months. The bucket name is
 * derived from how the active months are spaced — counting alone is not
 * enough (e.g. six months that are Jan-Mar + Jul-Sep are not "Every 2
 * Months", they're irregular). For divisor counts (1, 2, 3, 4, 6, 12) we
 * additionally check that the active months are evenly spaced; non-divisor
 * counts (5, 7, 8, 9, 10, 11) always fall through to 'Irregular'.
 */
export const FREQUENCY_ORDER = [
  'Monthly',
  'Every 2 Months',
  'Every 3 Months',
  'Every 4 Months',
  'Every 6 Months',
  'Annual',
  'Irregular',
];

function isEvenlySpaced(activeIdxs, count) {
  if (count <= 1) return true;
  const interval = 12 / count;
  if (!Number.isInteger(interval)) return false;
  const sorted = [...activeIdxs].sort((a, b) => a - b);
  const baseOffset = sorted[0] % interval;
  return sorted.every((m, i) => m === sorted[0] + i * interval && m % interval === baseOffset);
}

export function classifyFrequency(envelope, itemsForEnvelope) {
  if (!envelope) return 'Irregular';
  const active = new Set();
  for (const item of itemsForEnvelope || []) {
    if (!item || item.include === false) continue;
    const sched = item.monthly_schedule || {};
    MONTH_NAMES.forEach((m, i) => {
      const v = sched[m];
      if (v === true || (typeof v === 'number' && v !== 0)) active.add(i);
    });
  }
  const n = active.size;
  if (n === 0) return 'Irregular';
  if (n === 12) return 'Monthly';
  if (n === 1)  return 'Annual';
  if (!isEvenlySpaced(active, n)) return 'Irregular';
  if (n === 6) return 'Every 2 Months';
  if (n === 4) return 'Every 3 Months';
  if (n === 3) return 'Every 4 Months';
  if (n === 2) return 'Every 6 Months';
  return 'Irregular';
}

// ─── Per-envelope rollover policy ────────────────────────────────────────────

/** The owning month of a posted/forecast occurrence, falling back to its date.
 * @param {any} tx
 * @returns {string | null}
 */
export function occurrenceMonthOf(tx) {
  if (!tx) return null;
  if (typeof tx.forecast_month_key === 'string') return tx.forecast_month_key;
  const key = typeof tx.from_budget === 'string' ? tx.from_budget
    : typeof tx.forecast_dedup_key === 'string' ? tx.forecast_dedup_key : '';
  let found = null;
  for (const part of key.split(':')) if (/^\d{4}-(0[1-9]|1[0-2])$/.test(part)) found = part;
  if (found) return found;
  const dateMonth = String(tx.date || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(dateMonth) ? dateMonth : null;
}

/**
 * Whether `tx` is a fill for a month after `monthKey`: next month's
 * allocation dated before the 1st (a day-1 template moved back by
 * `prev_work_day`). The month-end rollover leaves such a fill out: it
 * belongs to the month it is for.
 *
 * @param {any} tx
 * @param {string} monthKey  YYYY-MM
 */
export function fillIsForLaterMonth(tx, monthKey) {
  if (!tx || tx.type !== 'fill') return false;
  const m = occurrenceMonthOf(tx);
  return !!m && m > monthKey;
}

/** Any occurrence for a later month, including an early bill or loan leg. */
export function isForLaterMonth(tx, monthKey) {
  const month = tx && occurrenceMonthOf(tx);
  return !!month && month > monthKey;
}

/**
 * For rollover arithmetic only, a payment shifted into a later month counts
 * at the end of its owning month. The stored/accounting date never changes.
 * @param {any[]} transactions
 * @returns {any[]}
 */
function rolloverDatedRows(transactions) {
  return (transactions || []).map(tx => {
    const month = tx && occurrenceMonthOf(tx);
    if (!month || String(tx.date || '').slice(0, 7) <= month) return tx;
    const [year, m] = month.split('-').map(Number);
    const last = new Date(year, m, 0).getDate();
    return { ...tx, date: `${month}-${last}` };
  });
}

/**
 * The month-end rollover adjustment for one envelope.
 *
 * The policy applies to the balance the month itself left, `pre`: the actual
 * balance without any occurrence for next month that landed early. Swept (or
 * covered) to zero, then those early effects replayed on top, is where the
 * envelope should stand; the adjustment is the difference from `actual`.
 * With no early fills that is the plain policy: −pre for a sweep, +|pre|
 * for a cover. A set-mode early fill already replaced the balance, so it
 * leaves nothing to adjust.
 *
 * Bug fixed 2026-10-02 (seen on 2026-08-31): the sweep used the balance with
 * September's early fill in it, and swept that fill back to Unallocated.
 *
 * @param {string} policy  'carry' | 'cover-from-unallocated' | 'zero-monthly'
 * @param {number} pre
 * @param {number} actual
 * @param {Array<{ mode: 'add', amount: number } | { mode: 'set', value: number }>} earlyEffects  date order
 * @returns {number}
 */
export function rolloverDelta(policy, pre, actual, earlyEffects = []) {
  const swept = (policy === 'zero-monthly' && pre > 0) || (policy === 'cover-from-unallocated' && pre < 0);
  if (!swept) return 0;
  let desired = 0;
  for (const e of earlyEffects) desired = e.mode === 'set' ? e.value : desired + e.amount;
  return round2(round2(desired) - actual);
}

/**
 * Apply each envelope's `rollover` policy at the start of a new month.
 * Returns adjustment transactions that, when persisted, enact the policy
 * for the *previous* month. Idempotent via `from_budget` markers shaped
 * `rollover:<envId>:<YYYY-MM>`.
 *
 * Policies:
 *   'carry'                  — default; nothing happens.
 *   'cover-from-unallocated' — if prevMonth ended negative, raise to 0
 *                              (effectively borrows from unallocated).
 *   'zero-monthly'           — sweep any positive remainder back to
 *                              unallocated, leaving envelope at 0.
 *
 * Either acts on the month's own money: a fill for next month dated in this
 * one is left out and kept (`rolloverDelta`).
 *
 * Adjustments are dated on the last day of the previous month so that
 * end-of-period reports already reflect them.
 *
 * @param {any[]} envelopes
 * @param {any[]} transactions
 * @param {Date} refDate  the clock, supplied by the caller
 * @param {(() => string) | null} [idGen]  injected so a caller can make ids
 *   deterministic; defaults to a random one
 * @param {any[]} [tombstones]
 * @param {string | null} [closingMonth] internal catch-up month; default previous month
 */
export function applyEnvelopeRollovers(envelopes, transactions, refDate, idGen = null, tombstones = [], closingMonth = null) {
  // `new Date(null)` is the epoch, so without this a missing clock posted a
  // rollover adjustment dated 1969-12-31 for "the previous month".
  requireClock(refDate, 'applyEnvelopeRollovers');
  // Id generation, not a calculation; `idGen` is a parameter and js/app.js
  // passes `generateId`.
  // eslint-disable-next-line bunvelope/no-ambient-clock -- see above
  if (typeof idGen !== 'function') idGen = () => `ro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newTxs = [];
  if (!Array.isArray(envelopes) || envelopes.length === 0) return { newTxs };

  const ref = new Date(refDate);
  const parts = closingMonth?.split('-').map(Number);
  const prev = parts ? new Date(parts[0], parts[1] - 1, 1) : new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  const prevMonthKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const lastDayPrev = new Date(prev.getFullYear(), prev.getMonth() + 1, 0);
  const pad = n => String(n).padStart(2, '0');
  const lastDayStr = `${lastDayPrev.getFullYear()}-${pad(lastDayPrev.getMonth() + 1)}-${pad(lastDayPrev.getDate())}`;

  const existingKeys = new Set();
  for (const t of transactions || []) if (t && t.from_budget) existingKeys.add(t.from_budget);
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) existingKeys.add(k);
  }

  const dated = rolloverDatedRows(transactions);
  const balances = computeEnvelopeBalances(dated, { asOf: lastDayPrev });
  // Next month's occurrences dated in this month: the policy acts on the month's
  // own money (`rolloverDelta`), so they are set aside and replayed after it.
  const early = dated
    .filter(t => isForLaterMonth(t, prevMonthKey) && String(t.date || '').slice(0, 10) <= lastDayStr)
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
  const earlySet = new Set(early);
  const preBalances = early.length
    ? computeEnvelopeBalances(dated.filter(t => !earlySet.has(t)), { asOf: lastDayPrev })
    : balances;
  const stamp = ref.toISOString();

  for (const env of envelopes) {
    if (!env || env.archived) continue;
    const policy = env.rollover || 'carry';
    if (policy === 'carry') continue;
    const key = `rollover:${env.id}:${prevMonthKey}`;
    if (existingKeys.has(key)) continue;
    // Round to 2 dp before the threshold check so the adjustment exactly
    // cancels the user-visible balance — no sub-cent drift bleeds into the
    // next period.
    const bal = round2(balances.get(env.id) || 0);
    const pre = round2(preBalances.get(env.id) || 0);
    const effects = [];
    for (const t of early) {
      const e = txRolloverReplayEffect(t, env.id);
      if (e) effects.push(e);
    }
    const delta = rolloverDelta(policy, pre, bal, effects);
    const payee = policy === 'cover-from-unallocated'
      ? 'Rollover: cover from unallocated'
      : 'Rollover: sweep to unallocated';
    if (Math.abs(delta) < CENT_EPSILON) continue;
    newTxs.push({
      id: idGen(),
      type: 'adjustment',
      target: 'envelope',
      target_id: env.id,
      amount: round2(delta),
      date: lastDayStr,
      status: 'posted',
      payee,
      note: null,
      from_budget: key,
      created_at: stamp,
      modified_at: stamp,
    });
  }

  return { newTxs };
}

// ─── Envelope goals ──────────────────────────────────────────────────────────

/**
 * Compute progress toward an envelope's optional savings goal. Returns null
 * when the envelope has no goal_amount set.
 *
 * Result shape:
 *   { goalAmount, goalDate, balance, fraction, monthlyRequired, daysRemaining,
 *     status: 'reached' | 'on-track' | 'behind' | 'early' | 'no-deadline' }
 *
 * `monthlyRequired` is positive when the user still needs to add money;
 * negative when the envelope already exceeds the goal. When goal_date is
 * unset we just report `status: 'reached' | 'no-deadline'` without
 * computing the cadence.
 *
 * The on-track test is a linear ramp: at the start you need nothing, on the
 * deadline you need all of it, and in between you need the elapsed fraction.
 *
 * `goal_start` — stamped when the goal is first set — gives the ramp a real
 * span, so a three-year goal is judged over three years and a three-month goal
 * over three months. Without it there is no start to measure from, and the
 * ramp falls back to assuming a one-year plan.
 *
 * That fallback used to be worse than a guess: `1 - daysRemaining / 365` goes
 * negative past a year while `fraction` never does, so EVERY goal more than a
 * year out reported 'on-track' — a goal 18 months away and completely unfunded
 * showed green, which is the one direction nobody investigates. Beyond the
 * fallback horizon such goals now report 'early': a muted dot and no verdict
 * tag, the same as 'no-deadline'. Envelopes carrying a `goal_start` never need
 * it, because their ramp always has a span.
 */
const PACE_HORIZON_DAYS = 365;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fraction of the goal that should already be saved, or null when there is no
 * usable span to measure against.
 *
 * A `goal_start` on or after the deadline is ignored rather than trusted: it
 * would divide by zero or run the ramp backwards, and a nonsensical span is
 * exactly the case where abstaining beats asserting.
 */
function expectedFraction(goalStart, goalDate, ref, daysRemaining) {
  if (typeof goalStart === 'string' && ISO_DATE.test(goalStart)) {
    const start = new Date(`${goalStart}T00:00:00`);
    const target = new Date(`${goalDate}T00:00:00`);
    const span = wholeDaysBetween(start, target);
    if (span > 0) {
      const elapsed = wholeDaysBetween(start, ref);
      return Math.min(1, Math.max(0, elapsed / span));
    }
  }
  // No usable start: assume a one-year plan, and say nothing beyond it.
  if (daysRemaining > PACE_HORIZON_DAYS) return null;
  return Math.min(1, Math.max(0, 1 - daysRemaining / PACE_HORIZON_DAYS));
}
/**
 * True for a `YYYY-MM-DD` string naming a real calendar day. `new Date`
 * rolls an impossible day forward (`2026-02-31` → 3 March) rather than
 * rejecting it, so the round-trip check is what catches it.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * @param {any} envelope
 * @param {number} currentBalance
 * @param {Date} refDate  the clock, supplied by the caller
 */
export function computeEnvelopeGoalProgress(envelope, currentBalance, refDate) {
  requireClock(refDate, 'computeEnvelopeGoalProgress');
  if (!envelope) return null;
  const goalAmount = Number(envelope.goal_amount);
  if (!Number.isFinite(goalAmount) || goalAmount <= 0) return null;

  const balance = Number(currentBalance) || 0;
  const fraction = balance / goalAmount;
  const reached = balance >= goalAmount - CENT_EPSILON;

  // An unparseable deadline is no deadline. It used to flow on as an Invalid
  // Date: `daysRemaining` NaN, `monthlyRequired` round2(NaN) = 0, and a
  // confident 'on-track' verdict on a date nobody could state.
  if (!isValidIsoDate(envelope.goal_date)) {
    return {
      goalAmount, goalDate: null, balance,
      fraction, monthlyRequired: null, daysRemaining: null,
      status: reached ? 'reached' : 'no-deadline',
    };
  }

  const target = new Date(envelope.goal_date + 'T00:00:00');
  const ref = new Date(refDate);
  ref.setHours(0, 0, 0, 0);
  const daysRemaining = wholeDaysBetween(ref, target);
  const monthsRemaining = Math.max(1, daysRemaining / 30.4375);
  const remaining = Math.max(0, goalAmount - balance);
  const monthlyRequired = round2(remaining / monthsRemaining);

  let status;
  if (reached) status = 'reached';
  else if (daysRemaining < 0) status = 'behind';
  else if (monthlyRequired <= 0) status = 'on-track';
  else {
    const expected = expectedFraction(envelope.goal_start, envelope.goal_date, ref, daysRemaining);
    if (expected === null) status = 'early';
    else status = fraction >= expected ? 'on-track' : 'behind';
  }

  return {
    goalAmount, goalDate: envelope.goal_date, balance,
    fraction, monthlyRequired, daysRemaining,
    status,
  };
}
