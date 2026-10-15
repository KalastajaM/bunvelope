// js/engine/item-dates.js — a plan item's optional start and end month.
//
// `start_month` / `end_month` are 'YYYY-MM' (inclusive) or empty. A legacy
// `as_schedule_until` (a date) is the end when `end_month` is absent.
//
// A plan month is a calendar month that repeats every year, so without dates
// a September ticked for next year is also due this September. Two readers
// honour the dates:
//
// - the date walker (`walkMonthlySchedule`, via `itemDateBounds`): posting,
//   the forecast, Review's forecast rows;
// - everything that reads the twelve months as "a year" (the annual totals,
//   Stress, the expense calendar, dynamic template amounts) is fed
//   `planItemsAsOf`, which switches off each month whose occurrence in the 12
//   months from the reference month lies outside the dates. "A year" then
//   means the coming 12 months.
import { MONTH_NAMES, requireClock } from './_constants.js';

const YEAR_MONTH = /^\d{4}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ym = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/**
 * @param {any} item
 * @returns {string | null}  'YYYY-MM'
 */
export function itemStartMonth(item) {
  const v = item?.start_month;
  return typeof v === 'string' && YEAR_MONTH.test(v) ? v : null;
}

/**
 * The last month the item applies: `end_month`, else the month of a legacy
 * `as_schedule_until`.
 * @param {any} item
 * @returns {string | null}  'YYYY-MM'
 */
export function itemEndMonth(item) {
  const v = item?.end_month;
  if (typeof v === 'string' && YEAR_MONTH.test(v)) return v;
  const until = item?.as_schedule_until;
  return typeof until === 'string' && ISO_DATE.test(until) ? until.slice(0, 7) : null;
}

/**
 * The bounds as walker dates: the 1st of the start month and the last day of
 * the end month. A legacy `as_schedule_until` keeps its exact date.
 * @param {any} item
 * @returns {{ since: string | null, until: string | null }}
 */
export function itemDateBounds(item) {
  const start = itemStartMonth(item);
  const end = item?.end_month;
  /** @type {string | null} */
  let until = null;
  if (typeof end === 'string' && YEAR_MONTH.test(end)) {
    const [y, m] = end.split('-').map(Number);
    until = `${end}-${pad(new Date(y, m, 0).getDate())}`;
  } else if (typeof item?.as_schedule_until === 'string' && ISO_DATE.test(item.as_schedule_until)) {
    until = item.as_schedule_until;
  }
  return { since: start ? `${start}-01` : null, until };
}

/**
 * The first day of a 'YYYY-MM' month, the reference date for a reader that
 * works on a named month.
 * @param {string} month
 * @returns {Date}
 */
export function monthStartDate(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(y, m - 1, 1);
}

/**
 * Whether the item has ended (its end month is before the reference month),
 * has not started (its start month is after it), or is active.
 * @param {any} item
 * @param {Date} refDate
 * @returns {{ status: 'active' | 'ended' | 'upcoming', start: string | null, end: string | null }}
 */
export function itemDateStatus(item, refDate) {
  const ref = ym(requireClock(refDate, 'itemDateStatus'));
  const start = itemStartMonth(item);
  const end = itemEndMonth(item);
  /** @type {'active' | 'ended' | 'upcoming'} */
  let status = 'active';
  if (end && end < ref) status = 'ended';
  else if (start && start > ref) status = 'upcoming';
  return { status, start, end };
}

/**
 * The items as the 12 months from `refDate` see them: a month whose
 * occurrence in that window lies outside the item's dates is switched off
 * (`false`, as loan upkeep stores it), and an item left with no month also
 * reserves no buffer. Undated items, and items the dates do not change, are
 * returned by reference, so the engine's caches keyed on identity still hit.
 * The result is a view: never store it.
 *
 * @param {any[]} items
 * @param {Date} refDate
 * @returns {any[]}
 */
export function planItemsAsOf(items, refDate) {
  const ref = requireClock(refDate, 'planItemsAsOf');
  /** @type {Record<string, string>} month name -> its 'YYYY-MM' in the window */
  const inWindow = {};
  for (let i = 0; i < 12; i++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() + i, 1);
    inWindow[MONTH_NAMES[d.getMonth()]] = ym(d);
  }
  return (items || []).map((item) => {
    if (!item || !item.monthly_schedule) return item;
    const start = itemStartMonth(item);
    const end = itemEndMonth(item);
    if (!start && !end) return item;
    /** @type {Record<string, any>} */
    const sched = { ...item.monthly_schedule };
    let changed = false;
    let anyOn = false;
    for (const mon of MONTH_NAMES) {
      const v = sched[mon];
      if (v === undefined || v === false) continue;
      const key = inWindow[mon];
      if ((start && key < start) || (end && key > end)) {
        sched[mon] = false;
        changed = true;
      } else {
        anyOn = true;
      }
    }
    if (!changed) return item;
    return anyOn
      ? { ...item, monthly_schedule: sched }
      : { ...item, monthly_schedule: sched, extra_buffer: 0 };
  });
}

/**
 * The plan a dynamic template fills from on `refDate`. The coming 12 months
 * alone (`planItemsAsOf`) count only the months an ending item has left, so an
 * item of 100 a month ending in three months was funded at 25, then 16.67,
 * then 8.33: 50 for 300 of cost. Owner decision 2026-10-04: an item already
 * running keeps its full monthly average (its whole schedule ÷ 12) up to and
 * including its end month, then counts nothing, the steady-state rule every
 * other item gets. An item not yet started is read as `planItemsAsOf` reads
 * it, end month included.
 * @param {any[]} items
 * @param {Date} refDate
 * @returns {any[]}
 */
export function planItemsForDynamicFill(items, refDate) {
  const ref = requireClock(refDate, 'planItemsForDynamicFill');
  const month = ym(ref);
  return planItemsAsOf((items || []).map((item) => {
    const end = itemEndMonth(item);
    if (!end || end < month) return item;
    const start = itemStartMonth(item);
    if (start && start > month) return item;
    const { end_month: _end, as_schedule_until: _until, ...running } = item;
    return running;
  }), ref);
}
