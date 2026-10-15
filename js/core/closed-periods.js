// js/core/closed-periods.js — which transaction dates fall in a closed month.
//
// A month is closed in one of two ways:
//   - by hand, from the Review page ("Close month"): `meta.closed_months`;
//   - automatically, when Settings → "Close months automatically" is on
//     (`meta.auto_close_after_months` = N): every month that ended more than
//     N months ago, except those reopened on the Review page
//     (`meta.reopened_months`). With N = 1 on 1 Oct, September (ended a day
//     ago) is open and August and earlier are closed.
//
// Closing is a soft lock: the write paths that change a row dated in a closed
// month ask first (js/ui/closed-period-guard.js), and the user can still go
// ahead. Nothing here blocks a write on its own.
//
// Pure: no DOM, no state import, so the guard and its tests share one rule.
// It lives in core for the month commands; js/state/closed-periods.js re-exports it.
// The clock is a parameter, as in the engine: "which months are closed" is a
// function of today once the automatic rule is on.

import { parseDate } from '../utils.js';

const YM = /^\d{4}-\d{2}$/;
export const monthList = (v) => (Array.isArray(v) ? v.filter(m => typeof m === 'string' && YM.test(m)) : []);
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * The months closed by hand, as a Set of 'YYYY-MM' keys. Malformed entries are
 * dropped.
 * @param {any} meta
 * @returns {Set<string>}
 */
export function closedMonthSet(meta) {
  return new Set(monthList(meta?.closed_months));
}

/**
 * The automatic rule's setting: N months, or 0 when off.
 * @param {any} meta
 * @returns {number}
 */
export function autoCloseAfterMonths(meta) {
  const n = Number(meta?.auto_close_after_months);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The first month the automatic rule leaves open: months before it are
 * auto-closed. Null when the rule is off.
 * @param {any} meta
 * @param {Date} today
 * @returns {string | null}
 */
export function autoCloseCutoff(meta, today) {
  const n = autoCloseAfterMonths(meta);
  if (!n || !(today instanceof Date)) return null;
  return ymOf(new Date(today.getFullYear(), today.getMonth() - n, 1));
}

/**
 * Whether the automatic rule closes `ym`, ignoring reopen exceptions.
 * @param {any} meta
 * @param {string} ym
 * @param {Date} today
 * @returns {boolean}
 */
export function isAutoClosedByRule(meta, ym, today) {
  const cutoff = autoCloseCutoff(meta, today);
  return !!cutoff && ym < cutoff;
}

/**
 * Whether month `ym` ('YYYY-MM') is closed: by hand, or by the automatic rule
 * unless it was reopened.
 * @param {any} meta
 * @param {string} ym
 * @param {Date} today
 * @returns {boolean}
 */
export function isMonthClosed(meta, ym, today) {
  if (!ym) return false;
  if (closedMonthSet(meta).has(ym)) return true;
  return isAutoClosedByRule(meta, ym, today) && !monthList(meta?.reopened_months).includes(ym);
}

/**
 * Whether month `ym` is over on `today`: it is before today's month. Only an
 * ended month can be closed (owner decision 2026-10-05).
 * @param {string} ym
 * @param {Date} today
 * @returns {boolean}
 */
export function monthHasEnded(ym, today) {
  return typeof ym === 'string' && today instanceof Date && ym < ymOf(today);
}

/**
 * The month to offer closing on the first open of a new month: the previous
 * month, when it is still open and the budget has a row dated in it (a budget
 * set up this month has nothing to close). Null otherwise.
 * @param {any} meta
 * @param {any[]} transactions
 * @param {Date} today
 * @returns {string | null}
 */
export function monthToOfferClosing(meta, transactions, today) {
  if (!(today instanceof Date)) return null;
  const prev = ymOf(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  if (isMonthClosed(meta, prev, today)) return null;
  const hasRow = (transactions || []).some(tx => monthOfDate(tx?.date) === prev);
  return hasRow ? prev : null;
}

/**
 * 'YYYY-MM' for a transaction date (ISO or anything `parseDate` reads), or
 * null when the date cannot be read.
 * @param {any} date
 * @returns {string | null}
 */
export function monthOfDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 7);
  const d = parseDate(date);
  if (!d) return null;
  return ymOf(d);
}

/**
 * The closed months a set of dates touches, sorted ascending. Empty when
 * nothing is closed, so callers can test `.length`.
 * @param {any} meta
 * @param {Iterable<any>} dates
 * @param {Date} today
 * @returns {string[]}
 */
export function closedMonthsIn(meta, dates, today) {
  const hit = new Set();
  for (const date of dates || []) {
    const ym = monthOfDate(date);
    if (ym && !hit.has(ym) && isMonthClosed(meta, ym, today)) hit.add(ym);
  }
  return [...hit].sort();
}

/**
 * How many of `txs` are dated in a closed month, the count the confirmation
 * names. Counts rows, not dates.
 * @param {any} meta
 * @param {any[]} txs
 * @param {Date} today
 * @returns {number}
 */
export function countClosedRows(meta, txs, today) {
  let n = 0;
  for (const tx of txs || []) {
    const ym = monthOfDate(tx?.date);
    if (ym && isMonthClosed(meta, ym, today)) n++;
  }
  return n;
}

/**
 * The meta after reopening `ym`: a manual close is dropped, and a month the
 * automatic rule still closes gets an exception in `reopened_months`.
 * @param {any} meta
 * @param {string} ym
 * @param {Date} today
 * @returns {any}
 */
export function reopenMonthPatch(meta, ym, today) {
  const closed = monthList(meta?.closed_months);
  const reopened = monthList(meta?.reopened_months);
  const next = { ...meta, closed_months: closed.filter(m => m !== ym) };
  if (isAutoClosedByRule(meta, ym, today) && !reopened.includes(ym)) {
    next.reopened_months = [...reopened, ym].sort();
  }
  return next;
}

/**
 * The meta after closing `ym` by hand: added to `closed_months`, and any
 * reopen exception for it dropped.
 * @param {any} meta
 * @param {string} ym
 * @returns {any}
 */
export function closeMonthPatch(meta, ym) {
  const closed = monthList(meta?.closed_months);
  const reopened = monthList(meta?.reopened_months);
  const next = { ...meta, closed_months: closed.includes(ym) ? closed : [...closed, ym] };
  if (reopened.includes(ym)) next.reopened_months = reopened.filter(m => m !== ym);
  return next;
}

/**
 * The meta after closing `ym` again under the automatic rule: its reopen
 * exception is dropped (Settings → the reopened months list).
 * @param {any} meta
 * @param {string} ym
 * @returns {any}
 */
export function dropReopenPatch(meta, ym) {
  const reopened = monthList(meta?.reopened_months);
  const next = { ...meta, reopened_months: reopened.filter(m => m !== ym) };
  if (!next.reopened_months.length) delete next.reopened_months;
  return next;
}
