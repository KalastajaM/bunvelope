// js/engine/scheduling.js — banking-day calendar, scheduled-item materialisation,
// and forward forecasting.
//
// Working-day adjustment honours per-country bank-holiday tables (FI, SE, NO,
// DK, DE, GB, US, EE, LV, LT). `materializeDueBudgetItems` posts real
// transactions for every active occurrence on or before today;
// `forecastScheduledTransactions` produces in-memory forecast rows from
// tomorrow forward.
//
// Pure functions. No DOM, no I/O.

import { MONTH_NAMES, isIncomeLikeItem, CENT_EPSILON, requireClock, resolveFundingStyle } from './_constants.js';
import { resolveTemplateLines } from './monthly-review.js';
import { itemDateBounds, planItemsForDynamicFill } from './item-dates.js';
import { computeEnvelopeBalances, txEnvelopeIds, txEnvelopeEffect } from './balances.js';
import { round2, validateAmount } from '../utils.js';
import { isTargetTransfer, isPendingTargetTransfer, resolveTargetTransfers, targetTransferOrder } from './target-transfers.js';
import { isPostedTx, txAbsAmount, txAccountDelta } from './tx-amounts.js';
import { loanRateOn, loanInstalment, loanDayCount, loanPeriodInterest } from './loan-terms.js';

// Local-time date formatting. Deliberately not `toISOString()`, which converts
// to UTC and lands on the previous day for anyone east of Greenwich.
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ── Working-day helpers ──────────────────────────────────────────────────────

function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31);
  const day = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekday(year, month, weekday, n) {
  const d = new Date(year, month - 1, 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (n - 1) * 7);
  return d;
}

function lastWeekday(year, month, weekday) {
  const d = new Date(year, month, 0);
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Bank non-working days for one year and country — the days a payment cannot
 * settle, which is what `workingDayAdjust` shifts around.
 *
 * Every country states its own Easter-relative days. They used to be added for
 * everyone up front, which gave the US Good Friday and Easter Monday (the
 * Federal Reserve is open on both), Estonia Easter Monday and Lithuania Good
 * Friday, none of which is a public holiday there. Sources: each country's
 * official public-holiday list; GB is England & Wales; US is the Federal
 * Reserve holiday schedule. Weekend-only days (Holy Saturday, Midsummer Day)
 * are harmless either way, since `workingDayAdjust` skips weekends itself.
 *
 * Euro countries also close on the TARGET2 days (1 Jan, Good Friday, Easter
 * Monday, 1 May, 25–26 Dec): interbank SEPA settlement stops even where the
 * day is not a public holiday, so a payment cannot land then either. That is
 * why Estonia keeps Easter Monday and Lithuania Good Friday.
 *
 * Deliberately NOT modelled: one-off days (royal events, Latvian song-festival
 * days).
 */
export function getBankingHolidays(year, country = 'FI') {
  const p = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const shift = (base, days) => { const d = new Date(base); d.setDate(d.getDate() + days); return d; };
  const h = new Set();
  const easter = easterSunday(year);
  const add = (m, d) => h.add(`${year}-${p(m)}-${p(d)}`);
  const addD = d => h.add(fmt(d));
  const easterDays = (...offsets) => { for (const o of offsets) addD(shift(easter, o)); };
  const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;
  // A fixed-date holiday landing on a weekend (or on a day already taken by
  // the one before it) moves to the next free weekday — GB substitute days,
  // Latvian transfers. Pass them in date order, so that a weekend Christmas
  // and Boxing Day end up on Monday and Tuesday.
  const addSubstituted = (...monthDays) => {
    for (const [m, d] of monthDays) {
      const date = new Date(year, m - 1, d);
      while (isWeekend(date) || h.has(fmt(date))) date.setDate(date.getDate() + 1);
      addD(date);
    }
  };

  switch (country) {
    case 'FI': {
      add(1, 1); add(1, 6);
      easterDays(-2, -1, 0, 1, 39);  // Good Fri, Holy Sat, Easter, Easter Mon, Ascension
      add(5, 1);
      let mEve = new Date(year, 5, 19);
      while (mEve.getDay() !== 5) mEve.setDate(mEve.getDate() + 1);
      addD(mEve);
      addD(shift(mEve, 1));
      // All Saints: the Saturday in 31 Oct – 6 Nov (same rule as SE; in
      // years where Oct 31 is a Saturday, that IS the holiday).
      let allS = new Date(year, 9, 31);
      while (allS.getDay() !== 6) allS.setDate(allS.getDate() + 1);
      addD(allS);
      add(12, 6); add(12, 24); add(12, 25); add(12, 26);
      break;
    }
    case 'SE': {
      // Maundy Thursday is an ordinary bank day in Sweden; National Day
      // (6 June) has been a public holiday since 2005.
      add(1, 1); add(1, 6);
      easterDays(-2, -1, 0, 1, 39);  // Good Fri, Holy Sat, Easter, Easter Mon, Ascension
      add(5, 1); add(6, 6);
      let mSat = new Date(year, 5, 20);
      while (mSat.getDay() !== 6) mSat.setDate(mSat.getDate() + 1);
      addD(mSat); addD(shift(mSat, -1));
      let allSSE = new Date(year, 9, 31);
      while (allSSE.getDay() !== 6) allSSE.setDate(allSSE.getDate() + 1);
      addD(allSSE);
      add(12, 24); add(12, 25); add(12, 26); add(12, 31);
      break;
    }
    case 'NO': {
      add(1, 1);
      // Maundy Thu, Good Fri, Holy Sat, Easter, Easter Mon, Ascension, Whit Sun, Whit Mon.
      easterDays(-3, -2, -1, 0, 1, 39, 49, 50);
      add(5, 1); add(5, 17);
      // Christmas Eve and New Year's Eve are bank holidays in Norway.
      add(12, 24); add(12, 25); add(12, 26); add(12, 31);
      break;
    }
    case 'DK': {
      add(1, 1);
      // Maundy Thu, Good Fri, Holy Sat, Easter, Easter Mon, Ascension, the bank
      // holiday the day after Ascension, Whit Sun, Whit Mon.
      easterDays(-3, -2, -1, 0, 1, 39, 40, 49, 50);
      if (year < 2024) easterDays(26);  // Great Prayer Day, abolished from 2024
      add(6, 5); add(12, 24); add(12, 25); add(12, 26); add(12, 31);
      break;
    }
    case 'DE': {
      // Nationwide days only. Maundy Thursday is not a holiday anywhere in
      // Germany.
      add(1, 1);
      easterDays(-2, 0, 1, 39, 49, 50);  // Good Fri, Easter, Easter Mon, Ascension, Whit Sun, Whit Mon
      add(5, 1); add(10, 3); add(12, 25); add(12, 26);
      break;
    }
    case 'GB': {
      addSubstituted([1, 1]);
      easterDays(-2, 0, 1);               // Good Friday, Easter, Easter Monday
      addD(nthWeekday(year, 5, 1, 1));    // Early May bank holiday
      addD(lastWeekday(year, 5, 1));      // Spring bank holiday
      addD(lastWeekday(year, 8, 1));      // Summer bank holiday
      addSubstituted([12, 25], [12, 26]);
      break;
    }
    case 'US': {
      // Federal Reserve holidays. One falling on a Sunday is observed on the
      // Monday; on a Saturday the Fed stays open the Friday before, so a
      // Saturday holiday closes nothing extra. No Easter days at all.
      const addFixed = (m, d) => {
        const date = new Date(year, m - 1, d);
        addD(date.getDay() === 0 ? shift(date, 1) : date);
      };
      addFixed(1, 1);
      addD(nthWeekday(year, 1, 1, 3));    // Martin Luther King Jr. Day
      addD(nthWeekday(year, 2, 1, 3));    // Washington's Birthday
      addD(lastWeekday(year, 5, 1));      // Memorial Day
      if (year >= 2021) addFixed(6, 19);  // Juneteenth
      addFixed(7, 4);
      addD(nthWeekday(year, 9, 1, 1));    // Labor Day
      addD(nthWeekday(year, 10, 1, 2));   // Columbus Day
      addFixed(11, 11);                   // Veterans Day
      addD(nthWeekday(year, 11, 4, 4));   // Thanksgiving
      addFixed(12, 25);
      break;
    }
    case 'EE': {
      add(1, 1); add(2, 24);
      // Good Friday, Easter, and Easter Monday — not a public holiday in
      // Estonia, but a TARGET2 closing day, so SEPA payments do not settle.
      easterDays(-2, 0, 1);
      add(5, 1); add(6, 23); add(6, 24); add(8, 20);
      add(12, 24); add(12, 25); add(12, 26);
      break;
    }
    case 'LV': {
      add(1, 1);
      easterDays(-2, 0, 1);  // Good Friday, Easter, Easter Monday
      add(5, 1); add(6, 23); add(6, 24);
      add(12, 24); add(12, 25); add(12, 26); add(12, 31);
      // Restoration of Independence (4 May) and Proclamation Day (18 Nov)
      // move to the following Monday when they fall on a weekend.
      addSubstituted([5, 4], [11, 18]);
      break;
    }
    case 'LT': {
      add(1, 1); add(2, 16); add(3, 11);
      // Easter, Easter Monday, and Good Friday — not a public holiday in
      // Lithuania, but a TARGET2 closing day, so SEPA payments do not settle.
      easterDays(-2, 0, 1);
      add(5, 1); add(6, 24); add(7, 6); add(8, 15); add(11, 1);
      if (year >= 2020) add(11, 2);  // All Souls' Day, a holiday since 2020
      add(12, 24); add(12, 25); add(12, 26);
      break;
    }
    default:
      // Unknown country: the generic set this table always applied.
      add(1, 1);
      easterDays(-2, 0, 1);
      break;
  }
  return h;
}

/**
 * Adjust a YYYY-MM-DD date to the nearest working day.
 * mode: 'exact' (no change), 'next_work_day', 'prev_work_day'.
 */
export function workingDayAdjust(dateStr, mode, country = 'FI') {
  if (!mode || mode === 'exact') return dateStr;
  const p = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const [y0, mo, d0] = dateStr.split('-').map(Number);
  const dt = new Date(y0, mo - 1, d0);
  let cachedYear = y0;
  let holidays = getBankingHolidays(y0, country);
  const nonWorking = date => {
    const dow = date.getDay();
    if (dow === 0 || dow === 6) return true;
    const yr = date.getFullYear();
    if (yr !== cachedYear) { holidays = getBankingHolidays(yr, country); cachedYear = yr; }
    return holidays.has(fmt(date));
  };
  const step = mode === 'next_work_day' ? 1 : -1;
  while (nonWorking(dt)) dt.setDate(dt.getDate() + step);
  return fmt(dt);
}

/**
 * Walk the scheduled occurrences of a single budget item within an inclusive
 * YYYY-MM-DD date range. Returns one entry per active occurrence, honoring
 * `monthly_schedule`, `payment_day` (clamped to month length),
 * `as_schedule_since`, `as_schedule_until` (last date occurrences may fall on —
 * the schedule recurs annually forever without it), and `skipped_occurrences`
 * (array of YYYY-MM keys).
 *
 * opts.dayType / opts.country: apply working-day adjustment to the payment date.
 * Returns: [{ date: 'YYYY-MM-DD', amount: number, monthKey: 'YYYY-MM' }]
 * Caller decides sign (expense vs income). Target transfers retain even zero
 * occurrences; their amount is resolved later against the account balance.
 * @param {any} item
 * @param {string} fromDateStr
 * @param {string} toDateStr
 * @param {{ dayType?: string, country?: string }} [opts]
 */
export function computeScheduledOccurrences(item, fromDateStr, toDateStr, opts = {}) {
  const out = [];
  if (!item || !item.as_schedule || !item.monthly_schedule) return out;

  // The posting window opens at the later of the stamped `as_schedule_since`
  // (no back-posting) and the item's start month, and closes at its end
  // (`end_month`, else a legacy `as_schedule_until`).
  const bounds = itemDateBounds(item);
  const stamped = typeof item.as_schedule_since === 'string' ? item.as_schedule_since : null;
  const since = stamped && bounds.since ? (stamped > bounds.since ? stamped : bounds.since) : (stamped || bounds.since);
  const occurrences = walkMonthlySchedule({
    months: item.monthly_schedule,
    payment_day: item.payment_day,
    since,
    until: bounds.until,
    skipped: item.skipped_occurrences,
  }, fromDateStr, toDateStr, opts);

  // Amount resolution stays here rather than in the walker: a template has no
  // amount at all, and the `>= CENT_EPSILON` gate below would silently drop every one
  // of its occurrences. Re-read the month value off `monthKey` — the walker
  // deliberately returns nothing money-shaped.
  for (const occ of occurrences) {
    const monIdx = Number(occ.monthKey.slice(5, 7)) - 1;
    const val = item.monthly_schedule[MONTH_NAMES[monIdx]];
    const amt = typeof val === 'number' ? val : (item.default_amount ?? 0);
    if (isTargetTransfer(item) || Math.abs(amt) >= CENT_EPSILON) {
      out.push({ date: occ.date, amount: amt, monthKey: occ.monthKey });
    }
  }
  return out;
}

/**
 * How far before the 1st the DEFAULT posting window reaches. A working-day
 * shift moves a payment a few days at most (the longest run of bank holidays
 * plus a weekend is well under a week), so this is enough to see every
 * occurrence that last month scheduled and this month pays.
 */
const SHIFT_LOOKBACK_DAYS = 7;

/**
 * The window a materialiser scans for due occurrences, and which of them it
 * owns. Shared by `materializeDueBudgetItems`, `materializeDueTemplateFills`
 * and the forecast helpers that must agree with them exactly
 * (`dueUnpostedTotal`, `findUnlinkedScheduledPayments` in envelope-forecast.js).
 *
 * With `since` the window starts there and never moves, so nothing inside it
 * can be lost. Without it the window used to start on the 1st of the current
 * month, compared against the RAW schedule date. An occurrence whose
 * working-day shift carried it into the next month — payment_day 31 with
 * next_work_day, and Oct 31 2026 is a Saturday, so it pays Mon Nov 2 — was
 * then skipped on Oct 31 (its payment date was still ahead) and outside the
 * window from Nov 1 on (its schedule date was last month). Its key was never
 * written and the bill simply never posted.
 *
 * So the default window reaches `SHIFT_LOOKBACK_DAYS` back, but only claims an
 * occurrence from before the 1st when its PAYMENT date is this month. That
 * keeps the backfill guard intact — an item created today does not post last
 * month's ordinary occurrences — while guaranteeing the shifted one is seen.
 * Dedup is still the `from_budget` key, so nothing can post twice.
 *
 * @param {string | null | undefined} since  `as_schedule_since` / `schedule.since`
 * @param {Date} today
 * @returns {{ fromStr: string, owns: (occ: { date: string, monthKey: string }) => boolean }}
 */
export function dueOccurrenceWindow(since, today) {
  if (typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return { fromStr: since, owns: () => true };
  }
  const y = today.getFullYear();
  const m = today.getMonth();
  const monthStart = ymd(new Date(y, m, 1));
  const monthKey = monthStart.slice(0, 7);
  return {
    fromStr: ymd(new Date(y, m, 1 - SHIFT_LOOKBACK_DAYS)),
    // `monthKey` is the SCHEDULE month, so this reads: scheduled this month
    // or later, or scheduled earlier but paying this month.
    owns: occ => occ.monthKey >= monthKey || occ.date >= monthStart,
  };
}

/**
 * Walk the active months of a monthly schedule within an inclusive
 * YYYY-MM-DD range, with no notion of money.
 *
 * spec: {
 *   months: { Jan: true|false|number, … }  — MONTH_NAMES keys; `undefined` and
 *                                            `false` are inactive, every other
 *                                            value (including 0) is active
 *   payment_day: number                    — clamped to each month's length
 *   since?: 'YYYY-MM-DD'                   — lower bound, ignored if malformed
 *   until?: 'YYYY-MM-DD'                   — upper bound, ignored if malformed.
 *                                            Compared against the RAW date like
 *                                            `since`, so a working-day
 *                                            adjustment cannot move an
 *                                            occurrence across the boundary.
 *                                            A monthly_schedule recurs annually
 *                                            forever by design; `until` is how
 *                                            a schedule that genuinely ENDS
 *                                            (a salary, a fixed-term contract)
 *                                            says so instead of firing again
 *                                            next year.
 *   skipped?: string[]                     — 'YYYY-MM' keys to drop
 * }
 * opts: { dayType?, country? } — working-day adjustment, as `workingDayAdjust`.
 *
 * Returns: [{ date: 'YYYY-MM-DD', monthKey: 'YYYY-MM' }]
 *
 * Range bounds compare the RAW schedule date at both ends, matching
 * `since`/`until`, so windows that tile the calendar claim every occurrence
 * exactly once. The upper bound used to compare the ADJUSTED date, which meant
 * a bill on the 31st of a month ending at a weekend belonged to neither of the
 * two windows that could have held it — too late for January by its payment
 * date, too early for February by its schedule date — and vanished.
 *
 * The emitted `date` is still the adjusted one, so it can fall a few days
 * outside the requested range. That is the point: the window says which
 * occurrence you are looking at, `date` says when the money moves. A caller
 * that must not act early gates on `date` itself — see `materializeDueBudgetItems`.
 */
export function walkMonthlySchedule(spec, fromDateStr, toDateStr, opts = {}) {
  const out = [];
  if (!spec || !spec.months) return out;
  const payDay = Number(spec.payment_day);
  if (!Number.isFinite(payDay) || payDay < 1) return out;

  if (!fromDateStr || !toDateStr) return out;

  const sinceStr = spec.since && /^\d{4}-\d{2}-\d{2}$/.test(spec.since)
    ? spec.since
    : null;
  const untilStr = spec.until && /^\d{4}-\d{2}-\d{2}$/.test(spec.until)
    ? spec.until
    : null;

  const skipped = new Set(Array.isArray(spec.skipped) ? spec.skipped : []);

  const scanFrom = sinceStr && sinceStr > fromDateStr ? sinceStr : fromDateStr;
  const scanTo = untilStr && untilStr < toDateStr ? untilStr : toDateStr;
  if (scanFrom > scanTo) return out;
  const [fy, fm] = scanFrom.split('-').map(Number);
  const [ty, tm] = scanTo.split('-').map(Number);
  let y = fy;
  let m = fm - 1;
  const endY = ty, endM = tm - 1;

  const { dayType, country } = opts;
  while (y < endY || (y === endY && m <= endM)) {
    const val = spec.months[MONTH_NAMES[m]];
    const active = val !== undefined && val !== false;
    if (active) {
      const lastDay = new Date(y, m + 1, 0).getDate();
      const day = Math.min(payDay, lastDay);
      const rawDate = `${y}-${pad(m + 1)}-${pad(day)}`;
      const payDate = workingDayAdjust(rawDate, dayType, country);
      const monthKey = `${y}-${pad(m + 1)}`;
      // Membership is decided by the RAW schedule date at BOTH ends, so
      // windows that tile the calendar claim every occurrence exactly once and
      // the same rule governs `since`/`until`.
      //
      // The upper bound used to compare the ADJUSTED date instead. A bill on
      // the 31st of a month ending at a weekend then belonged to neither of
      // the two windows that could hold it — too late for January by its
      // payment date, too early for February by its schedule date — and
      // vanished from every forecast from that month on.
      //
      // An occurrence whose adjustment carries it a few days past `toDateStr`
      // is now emitted, dated where the money really moves. Callers that must
      // not act before that date gate on `date` themselves; the materialisers
      // do exactly that, which is the difference between "this window owns the
      // occurrence" and "it has come due".
      if (rawDate >= fromDateStr && rawDate <= toDateStr && !skipped.has(monthKey)
          && (!sinceStr || rawDate >= sinceStr)
          && (!untilStr || rawDate <= untilStr)) {
        // rawDate rides along so callers can make calendar decisions (e.g. a
        // template's source_since) against the SCHEDULE date, like since/until
        // here — a working-day adjustment must not move an occurrence across
        // such a boundary.
        out.push({ date: payDate, monthKey, rawDate });
      }
    }
    m++;
    if (m > 11) { m = 0; y++; }
  }
  // The padding can emit a later month's occurrence before an earlier one when
  // an adjustment shifts it backwards, so settle the ascending-date contract
  // here rather than leaving it to month order.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ── Loan payments ────────────────────────────────────────────────────────────
//
// A `loan_payment` budget item pays a loan account (`to_account_id`, type
// `loan`) from `account_id`, out of its envelope. Each occurrence posts two
// rows: the month's interest, `owed × rate % ÷ 12` on what is still owed
// that day, as an expense; the item's other costs (`loan_fee`, a fixed
// handling charge per payment) as a second expense; and the rest of the
// payment as a `debt_payment` into the loan (the principal). The rate is the
// one in effect that day on the loan account (`loanRateOn`, its dated
// `interestRates`), else the item's own `loan_rate`. All of it comes out of
// the envelope, so envelope math sees the whole payment, as for an expense
// item; only the loan's balance and the Spending/Saving split differ. The
// last payment is cut to what is left, and a repaid loan posts nothing.
//
// The interest is the plan's estimate: a bank computes it on its own day
// count and rate changes. The posted rows are ordinary rows the user can
// correct from the statement.
//
// Keys: the first row written (principal, else interest, else fee) carries
// the occurrence key `${item}:${month}`, the others `${item}:${month}:interest`
// and `:fee`, so an occurrence always owns its key once posted. Forecast rows
// mirror this (the suffixed legs through `forecast_dedup_key`) and carry
// `forecast_loan_leg`.

/** @param {any} item */
function isLoanPaymentItem(item) {
  return !!item && item.kind === 'loan_payment';
}

/**
 * What the household still owes on `loanId` at the end of `dateStr`: minus
 * the loan account's balance from its opening balance and every non-forecast
 * row dated that day or earlier. Never below zero.
 *
 * @param {any} loan
 * @param {any[]} transactions
 * @param {string} dateStr
 */
export function loanOwedAt(loan, transactions, dateStr) {
  let bal = Number(loan?.initialBalance) || 0;
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    if (!d || d > dateStr) continue;
    bal += txAccountDelta(tx, loan.id);
  }
  return Math.max(0, round2(-bal));
}

/**
 * One occurrence's split: the item's other costs first, then `interest` on
 * `owed` at the yearly `rate`, the rest as `principal`, capped at what is
 * owed. Each part is capped by what the payment leaves.
 *
 * @param {any} item
 * @param {number} total   the payment
 * @param {number} owed
 * @param {number | null} [rate]  yearly %; defaults to the item's `loan_rate`
 * @returns {{ interest: number, fee: number, principal: number }}
 */
export function loanPaymentSplit(item, total, owed, rate = null) {
  // The fixed-payment split, whatever the item's method: kept for callers
  // that hand in the payment themselves. Posting and the forecast go through
  // `loanOccurrenceSplit`, which follows the method.
  const r = rate ?? validateAmount(item?.loan_rate) ?? 0;
  return loanInstalment({ loan_fee: item?.loan_fee }, { amount: total, owed, rate: r, monthKey: '' });
}

/**
 * One occurrence's split by the item's repayment method (`loanInstalment`),
 * at the rate in effect on its day. The one place posting, the forecast and
 * the repayment schedule get a loan payment from, so they cannot disagree.
 *
 * The interest follows the loan's day count (`loanDayCount`): by actual
 * days it runs from the previous payment day, `prevDate` when the caller
 * walks the occurrences in order, else found from the item's calendar.
 *
 * @param {any} item
 * @param {any} loan  the loan account
 * @param {{ date: string, amount: number, monthKey: string }} occ
 * @param {number} owed  before this payment
 * @param {{ prevDate?: string | null, country?: string }} [opts]
 */
export function loanOccurrenceSplit(item, loan, occ, owed, { prevDate = null, country = 'FI' } = {}) {
  const dayCount = loanDayCount(loan);
  const interest = dayCount === '30/360' ? undefined : loanPeriodInterest({
    owed, toStr: occ.date, dayCount,
    fromStr: prevDate || previousLoanPaymentDate(item, occ, country),
    rateOn: (day) => itemRateOn(item, loan, day),
  });
  return loanInstalment(item, { amount: occ.amount, owed, rate: itemRateOn(item, loan, occ.date), monthKey: occ.monthKey, interest });
}

/**
 * The payment day before `occ` on the item's calendar (working-day shifts,
 * skipped months), or the same day a month earlier when the calendar has
 * none: the first payment, or one after a gap longer than six weeks.
 *
 * @param {any} item
 * @param {{ date: string }} occ
 * @param {string} country
 */
export function previousLoanPaymentDate(item, occ, country = 'FI') {
  const [y, m, d] = occ.date.split('-').map(Number);
  const before = computeScheduledOccurrences(
    item, ymd(new Date(y, m - 1, d - 45)), ymd(new Date(y, m - 1, d - 1)),
    { dayType: item.schedule_day_type, country },
  );
  if (before.length) return before[before.length - 1].date;
  const last = new Date(y, m - 1, 0).getDate();
  return ymd(new Date(y, m - 2, Math.min(d, last)));
}

/** The yearly rate for a loan payment on `dateStr`: the loan's, else the item's. */
export function itemRateOn(item, loan, dateStr) {
  return loanRateOn(loan, dateStr) ?? (validateAmount(item?.loan_rate) ?? 0);
}

/**
 * The (up to) three rows of one loan-payment occurrence, posted or forecast:
 * principal, interest, other costs. `base` holds the fields they share.
 *
 * @param {any} item
 * @param {{ interest: number, fee: number, principal: number }} split
 * @param {string} key   the occurrence key `${item}:${month}`
 * @param {(leg: 'principal' | 'interest' | 'fee', key: string) => any} base
 */
function loanPaymentRows(item, split, key, base) {
  const rows = [];
  if (split.principal >= CENT_EPSILON) {
    rows.push({
      ...base('principal', key),
      type: 'debt_payment',
      amount: split.principal,
      from_account: item.account_id,
      to_account: item.to_account_id,
      envelope_id: item.envelope_id,
    });
  }
  for (const leg of /** @type {const} */ (['interest', 'fee'])) {
    if (split[leg] < CENT_EPSILON) continue;
    rows.push({
      ...base(leg, rows.length ? `${key}:${leg}` : key),
      type: 'expense',
      amount: split[leg],
      account: item.account_id,
      envelope_id: item.envelope_id,
    });
  }
  return rows;
}

/** Whether a loan-payment item can post: a live envelope, two distinct accounts, the target a loan. */
function loanItemPostable(item, envById, acctById) {
  const loan = acctById.get(item.to_account_id);
  if (!loan || loan.type !== 'loan' || item.to_account_id === item.account_id) return false;
  const env = envById.get(item.envelope_id);
  return !!env && !env.archived;
}

/**
 * Materialise transactions from budget items flagged `as_schedule`.
 *
 * Each active month in the item's `monthly_schedule` posts one transaction on
 * `payment_day` of that month, using the month's custom amount or
 * `default_amount`. Months with amount 0 or `false` are skipped.
 *
 * Kinds handled: `income` posts an `income`; `investment_transfer` posts an
 * `investment_transfer` (buy or dividend); `account_transfer` posts an
 * `account_transfer` from `account_id` to `to_account_id` (which must resolve
 * and differ from `account_id`; no envelope, no `account` key); every other
 * kind posts an `expense` against its envelope.
 *
 * Dedupe is purely via the emitted transaction's `from_budget` tag
 * (`<itemId>:YYYY-MM`). Calling this repeatedly is idempotent.
 *
 * An item with `include === false` (Disabled) is paused and posts nothing.
 *
 * Backfill is bounded by `as_schedule_since` — months whose payment date
 * falls before that are ignored, so flipping the flag on mid-year doesn't
 * retroactively post prior months.
 *
 * @param {Array} budgetItems
 * @param {Array} accounts
 * @param {Array} envelopes
 * @param {Array} transactions  - current tx list, used for dedupe and target-transfer balances
 * @param {Date}  today
 * @param {Function} idGen
 * @param {Array} _envelopeTemplates  - unused since templates gained their own
 *   schedule; the slot is kept because the remaining arguments are positional
 *   and `js/engine.js` is live-linked by the Budget project, where dropping it
 *   would silently shift `country` and `tombstones` one place left.
 * @returns {{ newTxs: Array }}
 */
export function materializeDueBudgetItems(budgetItems, accounts, envelopes, transactions, today, idGen, _envelopeTemplates = [], country = 'FI', tombstones = []) {
  // Id generation, not a calculation: `idGen` is a parameter and js/app.js
  // passes `generateId`. Nothing about the returned numbers depends on this
  // fallback, only the id string of a row that did not exist before.
  // eslint-disable-next-line bunvelope/no-ambient-clock -- see above
  if (typeof idGen !== 'function') idGen = () => `bi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newTxs = [];
  if (!Array.isArray(budgetItems) || budgetItems.length === 0) return { newTxs };

  const envById = new Map((envelopes || []).map(e => [e.id, e]));
  const acctById = new Map((accounts || []).map(a => [a.id, a]));

  const existingKeys = new Set();
  for (const t of transactions || []) {
    if (t && t.from_budget) existingKeys.add(t.from_budget);
  }
  // Tombstoned keys: occurrences the user explicitly deleted. Treat them as
  // "already exists" so the materialiser doesn't resurrect them.
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) existingKeys.add(k);
  }

  const todayStr = ymd(today);

  const stamp = requireClock(today, 'materialize').toISOString();
  for (const item of budgetItems) {
    if (!item || !item.as_schedule) continue;
    // Disabled pauses the item: nothing posts while it is off. Only an
    // explicit `false`; a legacy item without the field stays enabled.
    // Re-enabling restarts `as_schedule_since` (the plan page's save paths),
    // so the paused months are not backfilled.
    if (item.include === false) continue;
    if (!item.account_id || !acctById.has(item.account_id)) continue;
    const payDay = Number(item.payment_day);
    if (!Number.isFinite(payDay) || payDay < 1) continue;
    const isIncome = item.kind === 'income';
    const isInvestment = item.kind === 'investment_transfer';
    const isTransfer = item.kind === 'account_transfer';
    const invDirection = isInvestment && item.direction === 'dividend' ? 'dividend' : 'buy';
    if (isInvestment) {
      // Investment recurrence comes in two flavours:
      //   buy:      cash → investment, debits envelope (DCA monthly fund buy).
      //   dividend: investment → cash, optional envelope credit (income-shape).
      // Both require the investment account; envelope is required for buys
      // but optional for dividends, matching the per-tx dividend rules
      // shipped in the dividend-leg PR.
      if (!item.investment_account_id || !acctById.has(item.investment_account_id)) continue;
      if (item.investment_account_id === item.account_id) continue;
      if (invDirection === 'buy') {
        const env = envById.get(item.envelope_id);
        if (!env || env.archived) continue;
      } else if (item.envelope_id) {
        // Dividend with an envelope set must still resolve to a live
        // envelope; bare `envelope_id: null` is fine (lands in unallocated).
        const env = envById.get(item.envelope_id);
        if (!env || env.archived) continue;
      }
    } else if (isTransfer) {
      // Between two of the user's own accounts: both must resolve and differ.
      // No envelope, ever: a transfer is not spending.
      if (!item.to_account_id || !acctById.has(item.to_account_id)) continue;
      if (item.to_account_id === item.account_id) continue;
    } else if (isLoanPaymentItem(item)) {
      if (!loanItemPostable(item, envById, acctById)) continue;
    } else if (!isIncome) {
      const env = envById.get(item.envelope_id);
      const unallocatedExpense = !item.envelope_id && (!item.kind || item.kind === 'expense');
      if (!unallocatedExpense && (!env || env.archived)) continue;
    }
    if (!item.monthly_schedule) continue;

    const win = dueOccurrenceWindow(item.as_schedule_since, today);
    const occurrences = computeScheduledOccurrences(item, win.fromStr, todayStr, { dayType: item.schedule_day_type, country });

    for (const occ of occurrences) {
      if (!win.owns(occ)) continue;
      // The window owns an occurrence by its SCHEDULE date, but posting is
      // about the PAYMENT date: a working-day adjustment can carry a bill
      // scheduled today into next week, and materialising it now would date a
      // transaction in the future. Skip without claiming the key, so it posts
      // on the day it actually falls.
      if (occ.date > todayStr) continue;
      const key = `${item.id}:${occ.monthKey}`;
      if (existingKeys.has(key)) continue;
      if (isLoanPaymentItem(item)) {
        // Split on what is owed that day, after this run's earlier payments.
        const loan = acctById.get(item.to_account_id);
        const owed = loanOwedAt(loan, [...(transactions || []), ...newTxs], occ.date);
        const split = loanOccurrenceSplit(item, loan, occ, owed, { country });
        const rows = loanPaymentRows(item, split, key, (_leg, k) => ({
          id: idGen(), date: occ.date, status: 'posted',
          payee: item.description || loan.name || '', note: null,
          from_budget: k, created_at: stamp, modified_at: stamp,
        }));
        // A repaid loan posts nothing, and leaves the key free: nothing is owed.
        if (rows.length) existingKeys.add(key);
        newTxs.push(...rows);
        continue;
      }
      existingKeys.add(key);
      if (isIncome) {
        newTxs.push({
          id: idGen(),
          type: 'income',
          date: occ.date,
          status: 'posted',
          amount: Math.abs(occ.amount),
          envelope_id: null,
          account: item.account_id,
          payee: item.description || 'Income',
          note: null,
          from_budget: key,
          created_at: stamp,
          modified_at: stamp,
        });
      } else if (isInvestment) {
        // Buy: cash → investment. Dividend: investment → cash (income-shape;
        // matches the engine's per-tx dividend handling in tx-amounts.js).
        const fromAcct = invDirection === 'dividend' ? item.investment_account_id : item.account_id;
        const toAcct   = invDirection === 'dividend' ? item.account_id : item.investment_account_id;
        const defaultPayee = invDirection === 'dividend' ? 'Dividend' : 'Investment';
        const tx = {
          id: idGen(),
          type: 'investment_transfer',
          date: occ.date,
          status: 'posted',
          amount: Math.abs(occ.amount),
          direction: invDirection,
          from_account: fromAcct,
          to_account:   toAcct,
          envelope_id:  item.envelope_id || null,
          payee: item.description || defaultPayee,
          note: null,
          from_budget: key,
          created_at: stamp,
          modified_at: stamp,
        };
        if (item.symbol) tx.symbol = String(item.symbol).trim().toUpperCase();
        newTxs.push(tx);
      } else if (isTransfer) {
        // Identified by from/to, like an investment transfer: no `account`.
        newTxs.push({
          id: idGen(),
          type: 'account_transfer',
          ...(isTargetTransfer(item) ? { transfer_target_balance: item.target_balance, target_transfer_pending: true } : {}),
          date: occ.date,
          status: 'posted',
          amount: Math.abs(occ.amount),
          from_account: item.account_id,
          to_account:   item.to_account_id,
          envelope_id:  null,
          payee: item.description || 'Transfer',
          note: null,
          from_budget: key,
          created_at: stamp,
          modified_at: stamp,
        });
      } else {
        const env = envById.get(item.envelope_id);
        newTxs.push({
          id: idGen(),
          type: 'expense',
          date: occ.date,
          status: 'posted',
          amount: Math.abs(occ.amount),
          envelope_id: item.envelope_id,
          account: item.account_id,
          payee: item.description || (env && env.name) || '',
          note: null,
          from_budget: key,
          created_at: stamp,
          modified_at: stamp,
        });
      }
    }
  }

  if (!newTxs.some(isPendingTargetTransfer)) return { newTxs };
  const pending = new Set(newTxs);
  const resolved = resolveTargetTransfers(accounts || [], [...(transactions || []).filter(isPostedTx), ...newTxs]);
  return { newTxs: resolved.filter(tx => pending.has(tx) || tx.target_transfer_pending).sort(targetTransferOrder).flatMap(tx => {
    if (!tx.target_transfer_pending) return [tx];
    if (txAbsAmount(tx) < CENT_EPSILON) return [];
    const row = { ...tx };
    delete row.target_transfer_pending;
    delete row.funding_shortfall;
    return [row];
  }) };
}

/**
 * Produce in-memory forecast rows for scheduled budget items from tomorrow
 * through `endDateStr` (inclusive, YYYY-MM-DD). Rows are tagged
 * `is_forecast: true` and are never persisted.
 *
 * Full forecast assemblers pass pendingTargetTransfers and resolve after
 * netting and deduplication. Direct callers may pass transactions and tombstones
 * for target estimates; without them the estimate starts at opening balances.
 * Fixed-only schedules retain their existing caller-owned dedup contract.
 *
 * Income items get `type: 'income'`; investment transfers get
 * `type: 'investment_transfer'`; account transfers get
 * `type: 'account_transfer'` (from/to, no `account`, no envelope); expense
 * items get `type: 'expense'`. Amounts are positive magnitudes, matching the write-boundary convention
 * (`normalizeTxAmount`).
 */
/**
 * @param {any[]} budgetItems
 * @param {any[]} accounts
 * @param {any[]} envelopes
 * @param {Date} today
 * @param {string} endDateStr
 * @param {string|null} [fromDateStr]
 * @param {string} [country]
 * @param {{ transactions?: any[], tombstones?: string[], pendingTargetTransfers?: boolean }} [opts]
 */
export function forecastScheduledTransactions(budgetItems, accounts, envelopes, today, endDateStr, fromDateStr = null, country = 'FI', opts = {}) {
  const out = [];
  if (!Array.isArray(budgetItems) || budgetItems.length === 0) return out;

  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const fromStr = fromDateStr || ymd(tomorrow);
  if (fromStr > endDateStr) return out;

  const envById = new Map((envelopes || []).map(e => [e.id, e]));
  const acctById = new Map((accounts || []).map(a => [a.id, a]));

  for (const item of budgetItems) {
    if (!scheduledItemForecastable(item, envById, acctById)) continue;
    const occurrences = computeScheduledOccurrences(item, fromStr, endDateStr, { dayType: item.schedule_day_type, country });
    if (isLoanPaymentItem(item)) {
      out.push(...loanForecastRows(item, occurrences, acctById, opts.transactions, ymd(today), country));
      continue;
    }
    for (const occ of occurrences) out.push(scheduledForecastRow(item, occ, envById));
  }
  return resolveScheduledTargets(out, accounts, opts);
}

// Direct generator callers receive estimates. Full forecast assemblers defer
// until netting and planned spending are included, then resolve the same rows.
/**
 * @param {any[]} rows
 * @param {any[]} accounts
 * @param {{ transactions?: any[], tombstones?: string[], pendingTargetTransfers?: boolean }} opts
 * @returns {any[]}
 */
function resolveScheduledTargets(rows, accounts, opts) {
  if (opts.pendingTargetTransfers || !rows.some(isPendingTargetTransfer)) return rows;
  const transactions = opts.transactions || [];
  const taken = new Set([...transactions.map(tx => tx.from_budget), ...(opts.tombstones || [])]);
  const fresh = rows.filter(row => !taken.has(forecastKey(row)));
  const resolved = resolveTargetTransfers(accounts || [], transactions.concat(fresh));
  return resolved.slice(transactions.length);
}

/**
 * Forecast rows for a loan-payment item's occurrences, in date order: each
 * split on what the earlier ones leave owing, starting from the real
 * balance at `asOfStr`. Without `transactions` the start is the opening
 * balance, which callers avoid by passing them.
 *
 * @param {any} item
 * @param {Array<{ date: string, amount: number, monthKey: string }>} occurrences
 * @param {Map<string, any>} acctById
 * @param {any[] | undefined} transactions
 * @param {string} asOfStr
 */
function loanForecastRows(item, occurrences, acctById, transactions, asOfStr, country = 'FI') {
  const loan = acctById.get(item.to_account_id);
  let owed = loanOwedAt(loan, transactions || [], asOfStr);
  /** @type {string | null} */
  let prevDate = null;
  const out = [];
  for (const occ of [...occurrences].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const split = loanOccurrenceSplit(item, loan, occ, owed, { prevDate, country });
    prevDate = occ.date;
    const key = `${item.id}:${occ.monthKey}`;
    out.push(...loanPaymentRows(item, split, key, (leg, k) => ({
      id: `forecast:${k}`,
      is_forecast: true,
      forecast_budget_item_id: item.id,
      forecast_month_key: occ.monthKey,
      ...(k !== key ? { forecast_dedup_key: k } : {}),
      forecast_loan_leg: leg,
      date: occ.date,
      status: 'scheduled',
      payee: item.description || loan.name || '',
      note: null,
    })));
    owed = round2(owed - split.principal);
  }
  return out;
}

/**
 * Whether `forecastScheduledTransactions` generates rows for this item at all:
 * an enabled (`include !== false`) auto-posting item whose account (and, per kind, envelope, investment
 * account or to-account) resolves. An `account_transfer` needs a to-account
 * that resolves and differs from `account_id`, and never an envelope.
 */
export function scheduledItemForecastable(item, envById, acctById) {
  if (!item || !item.as_schedule) return false;
  // Disabled (explicit `include: false`) is paused: it will not post, so it
  // is not forecast either. Mirrors `materializeDueBudgetItems`.
  if (item.include === false) return false;
  if (!item.account_id || !acctById.has(item.account_id)) return false;
  if (item.kind === 'investment_transfer') {
    if (!item.investment_account_id || !acctById.has(item.investment_account_id)) return false;
    if (item.investment_account_id === item.account_id) return false;
    const isDividend = item.direction === 'dividend';
    // A buy always debits its envelope; a dividend only when it names one.
    if (!isDividend || item.envelope_id) {
      const env = envById.get(item.envelope_id);
      if (!env || env.archived) return false;
    }
  } else if (item.kind === 'account_transfer') {
    if (!item.to_account_id || !acctById.has(item.to_account_id)) return false;
    if (item.to_account_id === item.account_id) return false;
  } else if (isLoanPaymentItem(item)) {
    if (!loanItemPostable(item, envById, acctById)) return false;
  } else if (item.kind !== 'income') {
    const env = envById.get(item.envelope_id);
    const unallocatedExpense = !item.envelope_id && (!item.kind || item.kind === 'expense');
    if (!unallocatedExpense && (!env || env.archived)) return false;
  }
  return true;
}

/**
 * One forecast row for a scheduled budget item occurrence: `income`,
 * `investment_transfer`, `account_transfer` or (every other kind) `expense`.
 */
function scheduledForecastRow(item, occ, envById) {
  const base = {
    id: `forecast:${item.id}:${occ.monthKey}`,
    is_forecast: true,
    forecast_budget_item_id: item.id,
    forecast_month_key: occ.monthKey,
    date: occ.date,
    status: 'scheduled',
    account: item.account_id,
    note: null,
  };
  if (item.kind === 'income') {
    return {
      ...base,
      type: 'income',
      amount: Math.abs(occ.amount),
      envelope_id: null,
      payee: item.description || 'Income',
    };
  }
  if (item.kind === 'investment_transfer') {
    const invDirection = item.direction === 'dividend' ? 'dividend' : 'buy';
    const fromAcct = invDirection === 'dividend' ? item.investment_account_id : item.account_id;
    const toAcct   = invDirection === 'dividend' ? item.account_id : item.investment_account_id;
    const defaultPayee = invDirection === 'dividend' ? 'Dividend' : 'Investment';
    const row = {
      ...base,
      type: 'investment_transfer',
      direction: invDirection,
      amount: Math.abs(occ.amount),
      envelope_id: item.envelope_id || null,
      from_account: fromAcct,
      to_account:   toAcct,
      payee: item.description || defaultPayee,
      ...(item.symbol ? { symbol: String(item.symbol).trim().toUpperCase() } : {}),
    };
    // Drop the inherited `account` — investment_transfer rows are
    // identified by from/to instead, and downstream display code
    // (transactions chip, account-balance walks) keys off those.
    delete row.account;
    return row;
  }
  if (item.kind === 'account_transfer') {
    const row = {
      ...base,
      type: 'account_transfer',
      ...(isTargetTransfer(item) ? { transfer_target_balance: item.target_balance } : {}),
      amount: Math.abs(occ.amount),
      envelope_id: null,
      from_account: item.account_id,
      to_account:   item.to_account_id,
      payee: item.description || 'Transfer',
    };
    // Identified by from/to, as the investment row above.
    delete row.account;
    return row;
  }
  const env = envById.get(item.envelope_id);
  return {
    ...base,
    type: 'expense',
    amount: Math.abs(occ.amount),
    envelope_id: item.envelope_id,
    payee: item.description || (env && env.name) || '',
  };
}

/**
 * Owned-but-not-yet-paid scheduled occurrences: the ones
 * `materializeDueBudgetItems` owns by a SCHEDULE date on or before
 * `throughStr` (through the shared `dueOccurrenceWindow`) but skips because
 * the working-day-shifted PAYMENT date is still after today. payment_day 31
 * with next_work_day: Sat Oct 31 2026 pays Mon Nov 2, and on Nov 1 a forecast
 * starting at today's schedule date no longer sees October's occurrence while
 * post-due has not written it yet. Same row shape and key as
 * `forecastScheduledTransactions`; dedup against posted keys and tombstones
 * is the caller's, as there.
 *
 * @param {any[]} budgetItems
 * @param {any[]} accounts
 * @param {any[]} envelopes
 * @param {Date} today
 * @param {{ throughStr?: string, country?: string, transactions?: any[], tombstones?: string[], pendingTargetTransfers?: boolean }} [opts]  `throughStr`
 *   (inclusive, a schedule date) defaults to today
 */
export function forecastDueAheadTransactions(budgetItems, accounts, envelopes, today, opts = {}) {
  const out = [];
  if (!Array.isArray(budgetItems) || budgetItems.length === 0) return out;
  const todayStr = ymd(requireClock(today, 'forecastDueAheadTransactions'));
  const { throughStr = todayStr, country = 'FI' } = opts;
  const envById = new Map((envelopes || []).map(e => [e.id, e]));
  const acctById = new Map((accounts || []).map(a => [a.id, a]));
  for (const item of budgetItems) {
    if (!scheduledItemForecastable(item, envById, acctById)) continue;
    const win = dueOccurrenceWindow(item.as_schedule_since, today);
    if (win.fromStr > throughStr) continue;
    const occs = computeScheduledOccurrences(item, win.fromStr, throughStr, { dayType: item.schedule_day_type, country });
    const owned = occs.filter(occ => win.owns(occ) && occ.date > todayStr);
    if (isLoanPaymentItem(item)) {
      out.push(...loanForecastRows(item, owned, acctById, opts.transactions, todayStr, country));
      continue;
    }
    for (const occ of owned) out.push(scheduledForecastRow(item, occ, envById));
  }
  return resolveScheduledTargets(out, accounts, opts);
}

// ── Self-scheduled templates ─────────────────────────────────────────────────
//
// A template carrying its own `schedule` fires on a calendar, independent of
// any income event. The two helpers below are shared by the materialiser and
// the forecaster so the real fill and its forecast twin can never disagree
// about which months fire or which lines survive.

/**
 * Map a template's `schedule` block onto a `walkMonthlySchedule` spec, or null
 * when the template isn't self-scheduled.
 *
 * `months` values are booleans here rather than the numbers a budget item's
 * `monthly_schedule` may carry: a template's amounts come from its lines, so
 * there is nothing per-month to override.
 */
function templateScheduleSpec(tpl) {
  const sched = tpl && tpl.schedule;
  if (!sched || sched.enabled !== true) return null;
  const payDay = Number(sched.payment_day);
  if (!Number.isFinite(payDay) || payDay < 1) return null;
  if (!sched.months || typeof sched.months !== 'object') return null;
  return {
    months: sched.months,
    payment_day: payDay,
    since: sched.since,
    until: sched.until,
    skipped: sched.skipped,
  };
}

/**
 * Resolve which envelope, if any, FUNDS a self-scheduled template's fill for
 * an occurrence on `occDateStr`.
 *
 * A plain self-scheduled fill uses `source: 'allocation'` — envelope-side
 * only, drawn from unallocated. During a stretch with no income landing in
 * unallocated (severance parked in a buffer envelope, a sabbatical funded
 * from savings), the money sits in a named envelope instead, and the fill
 * must net to zero across envelopes: target lines up, one offsetting
 * negative line on the source envelope, unallocated untouched. That is what
 * `schedule.source_envelope_id` declares, and `schedule.source_since`
 * (optional, YYYY-MM-DD) delays it — occurrences before it fill from
 * unallocated as before, occurrences on/after it draw the source envelope.
 * Callers pass the occurrence's RAW schedule date (walkMonthlySchedule's
 * `rawDate`), matching how `since`/`until` are compared — a prev_work_day
 * adjustment shifting the Nov 1 fill to Oct 30 must not silently skip the
 * drawdown's first month.
 *
 * Returns the source envelope id, or null when the fill should come from
 * unallocated. Null (not a throw) on a missing/archived source envelope or a
 * source that is also a target line: silently emitting a fill whose source
 * leg the balance walker would skip (`if (!id) continue`) would LOOK funded
 * while leaking from unallocated — exactly the failure this feature exists
 * to prevent. Callers that can talk to an operator (the CLI's sanity check,
 * `report.mjs check`) flag those configurations; the engine just declines to
 * apply them.
 */
export function templateFillSourceId(tpl, occDateStr, lines, envById) {
  const sched = tpl && tpl.schedule;
  const srcId = sched && typeof sched.source_envelope_id === 'string' ? sched.source_envelope_id : null;
  if (!srcId) return null;
  const sinceOk = !(typeof sched.source_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.source_since))
    || occDateStr >= sched.source_since;
  if (!sinceOk) return null;
  const src = envById.get(srcId);
  if (!src || src.archived) return null;
  if (lines.some(l => l.envelope_id === srcId)) return null;
  // A `set` line no longer declines the source (2026-09-24). Its draw is the
  // delta that lands the target on its value, which the materialiser resolves
  // against the balance at posting and every forecast resolves against the
  // balance it has walked to — see `templateFillLines`.
  return srcId;
}

/**
 * Which self-scheduled templates DRAW on each envelope — the read-only,
 * date-free twin of `templateFillSourceId`, for surfaces that want to explain
 * an envelope's monthly drain rather than post it.
 *
 * A source envelope's balance falls every month by design, and nothing on the
 * envelope itself says why: the drawdown lives in another record's schedule.
 * Returns `Map<envelopeId, Array<{ id, name, sourceSince }>>` so a card can
 * name the template responsible.
 *
 * Mirrors every decline `templateFillSourceId` can make from the template
 * alone — the source is also a declared target, the schedule's `until` has
 * passed —
 * so a chip built from this can never claim a drain the engine will refuse to
 * perform. The two declines it CANNOT make here are the ones needing state
 * this helper is not given: a missing/archived source envelope (the caller is
 * iterating live envelopes, so an entry keyed to one it doesn't have is
 * simply never read), and a dynamic template whose assignments currently
 * resolve to no lines.
 *
 * `sourceSince` is passed through un-compared: a drawdown that starts next
 * quarter is worth announcing before it begins, and only the caller knows
 * whether it wants to say "funds X" or "funds X from March".
 *
 * opts: { asOf?: string } — YYYY-MM-DD, defaults to no `until` filtering.
 */
export function computeTemplateSourceDraws(envelopeTemplates, opts = {}) {
  const out = new Map();
  if (!Array.isArray(envelopeTemplates)) return out;
  const asOf = typeof opts.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)
    ? opts.asOf
    : null;

  for (const tpl of envelopeTemplates) {
    const sched = tpl && tpl.schedule;
    if (!sched || sched.enabled !== true) continue;
    const srcId = typeof sched.source_envelope_id === 'string' ? sched.source_envelope_id : '';
    if (!srcId) continue;
    if (asOf && typeof sched.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.until)
      && sched.until < asOf) continue;

    // Declared targets, not resolved ones: a dynamic template's assignments
    // are the same conflict surface as a manual template's lines, and both
    // are what the editor validates against.
    const declared = tpl.kind === 'dynamic'
      ? (Array.isArray(tpl.assignments) ? tpl.assignments : [])
      : (Array.isArray(tpl.lines) ? tpl.lines : []);
    if (declared.some(l => l && l.envelope_id === srcId)) continue;
    // A set-mode line draws the source too — by the delta that lands its
    // target, not a fixed amount — so it is a draw like any other.

    const entry = {
      id: tpl.id,
      name: tpl.name || '',
      sourceSince: typeof sched.source_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.source_since)
        ? sched.source_since
        : null,
    };
    const list = out.get(srcId);
    if (list) list.push(entry);
    else out.set(srcId, [entry]);
  }
  return out;
}

/**
 * The emitted lines for one self-scheduled fill occurrence: the template's
 * live target lines, plus — when a source envelope applies — one offsetting
 * add-line so the fill nets to zero across envelopes. Shared by the
 * materialiser and the forecaster so the real fill and its forecast twin can
 * never disagree about where the money comes from.
 *
 * A `set` line's draw is not its amount: it is the delta that lands the
 * target envelope on that value, `value − balance before the fill`, which is
 * negative when the envelope already holds more (the surplus then flows back
 * to the source, keeping the fill net-zero). So:
 *   - the materialiser passes `balanceBefore` and gets the resolved line;
 *   - the forecaster cannot know the balance a future row will meet, so it
 *     gets a PLACEHOLDER source line carrying only the add part, and the row
 *     is marked `source_set_pending`. Whoever walks the rows in date order
 *     resolves it: `resolveSetSourceLegs` for a flat transaction list (the
 *     Forecast lens), the per-envelope projection for its own walk.
 *
 * @param {any} tpl
 * @param {string} occDateStr
 * @param {{ envelope_id: string, mode: 'add' | 'set', amount: number }[]} lines
 * @param {Map<string, any>} envById
 * @param {((envelopeId: string) => number) | null} [balanceBefore]
 * @returns {{ lines: any[], sourceEnvelopeId: string | null, setPending: boolean }}
 */
function templateFillLines(tpl, occDateStr, lines, envById, balanceBefore = null) {
  const srcId = templateFillSourceId(tpl, occDateStr, lines, envById);
  const out = lines.map(l => ({ ...l }));
  if (!srcId) return { lines: out, sourceEnvelopeId: null, setPending: false };
  const addTotal = out.reduce((s, l) => s + (l.mode === 'set' ? 0 : (Number(l.amount) || 0)), 0);
  const setLines = out.filter(l => l.mode === 'set');
  if (!setLines.length) {
    const totalR = Math.round(addTotal * 100) / 100;
    if (!(totalR > 0)) return { lines: out, sourceEnvelopeId: null, setPending: false };
    out.push({ envelope_id: srcId, mode: 'add', amount: -totalR });
    return { lines: out, sourceEnvelopeId: srcId, setPending: false };
  }
  if (typeof balanceBefore !== 'function') {
    out.push({ envelope_id: srcId, mode: 'add', amount: round2(-addTotal) || 0 });
    return { lines: out, sourceEnvelopeId: srcId, setPending: true };
  }
  const draw = round2(setLines.reduce(
    (s, l) => s + (Number(l.amount) || 0) - (balanceBefore(l.envelope_id) || 0),
    addTotal,
  ));
  // Nothing to move: the targets already sit on their values. No zero line.
  if (Math.abs(draw) < CENT_EPSILON) return { lines: out, sourceEnvelopeId: null, setPending: false };
  out.push({ envelope_id: srcId, mode: 'add', amount: -draw });
  return { lines: out, sourceEnvelopeId: srcId, setPending: false };
}

/**
 * The lines a posted fill stores. A stored fill is add-only, as
 * `allocation.fill` writes it (owner decision 2026-10-04): each set line
 * becomes its delta to the target on the balance the fill meets (negative
 * when the envelope already holds more), and keeps the target in
 * `set_target`, which a month-end sweep replays (`txRolloverReplayEffect`). A
 * stored set line would overwrite the balance, so a row dated before it and
 * entered later would vanish from the envelope, and the strict-ledger policy
 * refuses it. A set line already on its target stays as a zero line: the
 * sweep still needs its target.
 *
 * @param {{ envelope_id: string, mode: 'add' | 'set', amount: number }[]} lines
 * @param {((envelopeId: string) => number) | null} balanceBefore
 * @returns {{ envelope_id: string, mode: 'add' | 'set', amount: number, set_target?: number }[]}
 */
export function storedFillLines(lines, balanceBefore) {
  if (typeof balanceBefore !== 'function') return lines;
  return lines.map(l => (l.mode === 'set'
    ? {
      envelope_id: l.envelope_id,
      mode: /** @type {'add'} */ ('add'),
      amount: round2((Number(l.amount) || 0) - (balanceBefore(l.envelope_id) || 0)) || 0,
      set_target: round2(Number(l.amount) || 0),
    }
    : l));
}

/**
 * Resolve one `source_set_pending` fill row: rewrite its placeholder source
 * line to also carry each set line's delta, `deltaOf(line)`, and drop the
 * pending mark. Returns a copy; the input row is not mutated (forecast rows
 * are shared by memoized callers).
 *
 * @param {any} row
 * @param {(line: { envelope_id: string, amount: number }) => number} deltaOf
 */
export function resolvePendingSetRow(row, deltaOf) {
  if (!row || !row.source_set_pending || !Array.isArray(row.lines)) return row;
  const srcId = row.source_envelope_id;
  let setDelta = 0;
  for (const l of row.lines) {
    if (l && l.mode === 'set') setDelta += Number(deltaOf(l)) || 0;
  }
  const lines = row.lines.map(l => (l && l.envelope_id === srcId && l.mode !== 'set'
    ? { ...l, amount: round2((Number(l.amount) || 0) - setDelta) || 0 }
    : l));
  const out = { ...row, lines };
  delete out.source_set_pending;
  return out;
}

/**
 * Resolve every `source_set_pending` forecast fill in a flat transaction list
 * by walking it in balance order (date, then array index — the order
 * `computeEnvelopeBalances` applies) and reading each set line's target
 * balance just before the row. A set line's delta is `value − balance`, and
 * the source line draws exactly that on top of the add part, so the fill
 * nets to zero across envelopes the way a posted sourced fill does.
 *
 * Returns the input array itself when nothing is pending, so a list without
 * set-funded sources keeps its identity (and every balance memo keyed on it).
 *
 * @param {any[]} rows
 * @returns {any[]}
 */
export function resolveSetSourceLegs(rows) {
  if (!Array.isArray(rows) || !rows.some(r => r && r.source_set_pending)) return rows;
  const day = r => String((r && r.date) || '').slice(0, 10);
  const order = rows.map((_, i) => i).sort((a, b) => {
    const da = day(rows[a]);
    const db = day(rows[b]);
    return da < db ? -1 : da > db ? 1 : a - b;
  });
  const bal = new Map();
  const out = rows.slice();
  for (const i of order) {
    let tx = rows[i];
    if (!tx) continue;
    if (tx.source_set_pending) {
      tx = resolvePendingSetRow(tx, l => (Number(l.amount) || 0) - (bal.get(l.envelope_id) || 0));
      out[i] = tx;
    }
    for (const id of txEnvelopeIds(tx)) {
      const e = txEnvelopeEffect(tx, id);
      if (!e) continue;
      bal.set(id, e.mode === 'set' ? e.value : (bal.get(id) || 0) + e.amount);
    }
  }
  return out;
}

/**
 * Resolve a template's effective lines and drop any whose envelope is missing
 * or archived. Returns [] when nothing survives, which both callers treat as
 * "emit nothing for this template" — a fill is money movement, so a
 * half-resolvable template moves none of it.
 */
export function liveTemplateLines(tpl, budgetItems, envById, refDate) {
  // A dynamic template fills from the plan in force on `refDate`: an item
  // that has ended stops being funded, one still running is funded at its
  // full rate until it ends (`planItemsForDynamicFill`).
  const dated = planItemsForDynamicFill(budgetItems || [], requireClock(refDate, 'liveTemplateLines'));
  return resolveTemplateLines(tpl, dated)
    .filter(l => {
      if (!l || !l.envelope_id) return false;
      const env = envById.get(l.envelope_id);
      return !!env && !env.archived;
    })
    .map(l => ({
      envelope_id: l.envelope_id,
      mode: l.mode === 'set' ? 'set' : 'add',
      amount: Math.abs(Number(l.amount) || 0),
    }));
}

/** Dedup key for a self-scheduled template fill. The `tpl:` prefix keeps this
 *  namespace clear of budget items' `${itemId}:${monthKey}` and
 *  `${itemId}:${monthKey}:fill`. Exported so a manually-entered fill for a
 *  self-scheduled template can claim the same key and suppress the
 *  materialiser's twin — the CLI's duplicate guard depends on the formats
 *  never drifting apart. */
export function templateFillKey(tplId, monthKey) {
  return `tpl:${tplId}:${monthKey}`;
}

/**
 * Materialise fills for templates that carry their own calendar schedule.
 *
 * The counterpart to `materializeDueBudgetItems`, which only ever emits a fill
 * as a leg of a scheduled *income* occurrence — and therefore emits nothing at
 * all for a month whose income is zero, taking the allocation down with the
 * paycheck. A self-scheduled template fires on its own pay day regardless.
 *
 * Emitted fills use `source: 'allocation'`, which is purely envelope-side:
 * only `source: 'new_income'` debits an account (see `computeAccountBalances`).
 * The money therefore comes out of unallocated, and a template that outruns
 * unallocated drives it negative rather than being skipped — the trigger stays
 * predictable from the schedule alone, without consulting balances.
 *
 * Unless `schedule.source_envelope_id` applies (see `templateFillSourceId`):
 * then the emitted lines carry one extra negative add-line on that envelope,
 * the fill nets to zero across envelopes, and unallocated does not move — the
 * fill is funded from the named envelope instead. `schedule.source_since`
 * bounds when that kicks in, so one template can fill from income-fed
 * unallocated while the salary lasts and draw a buffer envelope after.
 *
 * Dedupe is via the emitted `from_budget` tag plus `tombstones`, exactly as in
 * `materializeDueBudgetItems`, so re-running is idempotent and a fill the user
 * deleted stays deleted.
 *
 * Backfill is bounded by `schedule.since`, defaulting to the 1st of the current
 * month — so enabling a schedule mid-month posts this month's fill immediately,
 * matching how flipping `as_schedule` on a budget item behaves.
 */
export function materializeDueTemplateFills(
  envelopeTemplates, budgetItems, envelopes, transactions, today, idGen,
  country = 'FI', tombstones = [],
) {
  // Id generation, as above.
  // eslint-disable-next-line bunvelope/no-ambient-clock -- see above
  if (typeof idGen !== 'function') idGen = () => `tf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newTxs = [];
  if (!Array.isArray(envelopeTemplates) || envelopeTemplates.length === 0) return { newTxs };

  const envById = new Map((envelopes || []).map(e => [e.id, e]));

  const existingKeys = new Set();
  for (const t of transactions || []) {
    if (t && t.from_budget) existingKeys.add(t.from_budget);
  }
  for (const k of tombstones || []) {
    if (typeof k === 'string' && k) existingKeys.add(k);
  }

  const todayStr = ymd(today);
  const stamp = requireClock(today, 'materialize').toISOString();

  for (const tpl of envelopeTemplates) {
    const spec = templateScheduleSpec(tpl);
    if (!spec) continue;

    const lines = liveTemplateLines(tpl, budgetItems, envById, today);
    if (lines.length === 0) continue;

    const win = dueOccurrenceWindow(spec.since, today);
    const occurrences = walkMonthlySchedule(
      spec, win.fromStr, todayStr,
      { dayType: tpl.schedule.day_type, country },
    );

    for (const occ of occurrences) {
      if (!win.owns(occ)) continue;
      // Same gate as `materializeDueBudgetItems`: own the occurrence by its
      // schedule date, post it on its payment date.
      if (occ.date > todayStr) continue;
      const key = templateFillKey(tpl.id, occ.monthKey);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      // A set line funded from a source draws the delta to its target, read
      // off the balance the fill meets: everything dated on or before it,
      // including fills this same run has already emitted for earlier months.
      const balanceBefore = lines.some(l => l.mode === 'set')
        ? (() => {
          const eb = computeEnvelopeBalances([...(transactions || []), ...newTxs], { asOf: occ.date });
          return id => eb.get(id) || 0;
        })()
        : null;
      const resolved = templateFillLines(
        tpl, occ.rawDate || occ.date, lines, envById, balanceBefore,
      );
      const { sourceEnvelopeId } = resolved;
      const fillLines = storedFillLines(resolved.lines, balanceBefore);
      const tx = {
        id: idGen(),
        type: 'fill',
        date: occ.date,
        status: 'posted',
        source: 'allocation',
        lines: fillLines,
        payee: tpl.name || 'Template allocation',
        note: null,
        from_budget: key,
        template_id: tpl.id,
        created_at: stamp,
        modified_at: stamp,
      };
      if (sourceEnvelopeId) tx.source_envelope_id = sourceEnvelopeId;
      newTxs.push(tx);
    }
  }

  return { newTxs };
}

/**
 * Forecast the fills of self-scheduled templates — the forward-looking twin of
 * `materializeDueTemplateFills`, mirroring what `forecastScheduledTransactions` does
 * for income-linked ones. Rows are tagged `is_forecast: true` and never
 * persisted.
 *
 * `forecast_dedup_key` is byte-identical to the `from_budget` the materialiser
 * writes, so a fill that has already posted suppresses its forecast twin via
 * `forecastKey()` in envelope-forecast.js.
 *
 * opts: { fromDateStr?: string, country?: string }
 */
export function forecastTemplateFills(envelopeTemplates, budgetItems, envelopes, today, endDateStr, opts = {}) {
  const out = [];
  if (!Array.isArray(envelopeTemplates) || envelopeTemplates.length === 0) return out;

  const { fromDateStr = null, country = 'FI' } = opts;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const fromStr = fromDateStr || ymd(tomorrow);
  if (fromStr > endDateStr) return out;

  const envById = new Map((envelopes || []).map(e => [e.id, e]));

  for (const tpl of envelopeTemplates) {
    const spec = templateScheduleSpec(tpl);
    if (!spec) continue;

    const lines = liveTemplateLines(tpl, budgetItems, envById, today);
    if (lines.length === 0) continue;

    const occurrences = walkMonthlySchedule(
      spec, fromStr, endDateStr,
      { dayType: tpl.schedule.day_type, country },
    );

    for (const occ of occurrences) out.push(templateForecastRow(tpl, occ, lines, envById));
  }
  return out;
}

/** One forecast fill row for a self-scheduled template occurrence. */
function templateForecastRow(tpl, occ, lines, envById) {
  const { lines: fillLines, sourceEnvelopeId, setPending } = templateFillLines(
    tpl, occ.rawDate || occ.date, lines, envById,
  );
  const row = {
    id: `forecast:tpl:${tpl.id}:${occ.monthKey}`,
    is_forecast: true,
    forecast_template_id: tpl.id,
    forecast_month_key: occ.monthKey,
    forecast_dedup_key: templateFillKey(tpl.id, occ.monthKey),
    type: 'fill',
    date: occ.date,
    status: 'scheduled',
    source: 'allocation',
    template_id: tpl.id,
    lines: fillLines,
    payee: tpl.name || 'Template allocation',
    note: null,
  };
  if (sourceEnvelopeId) row.source_envelope_id = sourceEnvelopeId;
  if (setPending) row.source_set_pending = true;
  return row;
}

/**
 * Owned-but-not-yet-paid template fills: occurrences the materialiser's own
 * window (`dueOccurrenceWindow`) owns by a SCHEDULE date on or before
 * `throughStr`, whose working-day-shifted PAYMENT date is still after today.
 * `materializeDueTemplateFills` skips them until they pay, and the forecasters
 * start at a schedule date of today or tomorrow, so without this nothing
 * counts them (payment_day 31, next_work_day: Sat Oct 31 2026 pays Mon Nov 2,
 * and on Nov 1 the October fill is in no forecast at all). Same row shape and
 * dedup key as `forecastTemplateFills`, so a caller merging both keeps one.
 *
 * @param {any[]} envelopeTemplates
 * @param {any[]} budgetItems
 * @param {any[]} envelopes
 * @param {Date} today
 * @param {{ throughStr?: string, country?: string }} [opts]  `throughStr`
 *   (inclusive, a schedule date) defaults to today
 */
export function forecastDueAheadTemplateFills(envelopeTemplates, budgetItems, envelopes, today, opts = {}) {
  const out = [];
  if (!Array.isArray(envelopeTemplates) || envelopeTemplates.length === 0) return out;
  const todayStr = ymd(requireClock(today, 'forecastDueAheadTemplateFills'));
  const { throughStr = todayStr, country = 'FI' } = opts;
  const envById = new Map((envelopes || []).map(e => [e.id, e]));
  for (const tpl of envelopeTemplates) {
    const spec = templateScheduleSpec(tpl);
    if (!spec) continue;
    const lines = liveTemplateLines(tpl, budgetItems, envById, today);
    if (lines.length === 0) continue;
    const win = dueOccurrenceWindow(spec.since, today);
    if (win.fromStr > throughStr) continue;
    const occs = walkMonthlySchedule(spec, win.fromStr, throughStr, { dayType: tpl.schedule.day_type, country });
    for (const occ of occs) {
      if (!win.owns(occ) || occ.date <= todayStr) continue;
      out.push(templateForecastRow(tpl, occ, lines, envById));
    }
  }
  return out;
}

/**
 * Forecast the spend a budget item PLANS but does not auto-post — every item
 * with a `monthly_schedule` that is not flagged `as_schedule`.
 *
 * `forecastScheduledTransactions` gates on `as_schedule` for a good reason: it
 * feeds the Transactions view, where a forecast row is something the user
 * clicks to post, and offering to post a line the budget never intended to
 * automate would be wrong. But "does not auto-post" is not "will not happen" —
 * a quarterly hairdresser visit is planned spending that simply gets recorded
 * by hand. Any projection that asks "will this envelope run dry" must count it,
 * or an envelope funded for exactly that spending reads as permanently
 * over-funded. In the sample budget 14 of 15 items are non-scheduled, so
 * omitting them means omitting nearly the whole budget.
 *
 * Rows are `is_forecast: true` (never persisted) and additionally
 * `is_planned: true`, so a consumer that only wants auto-posting rows can
 * still tell the two apart.
 *
 * The dedup key matches what the materialiser would write if the item were
 * ever flipped to `as_schedule`, so the two sources can never double up.
 *
 * opts: { fromDateStr?: string, country?: string, monthlyBuckets?: boolean }
 */
export function forecastPlannedExpenses(budgetItems, accounts, envelopes, today, endDateStr, opts = {}) {
  const out = [];
  if (!Array.isArray(budgetItems) || budgetItems.length === 0) return out;

  const { fromDateStr = null, country = 'FI' } = opts;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const fromStr = fromDateStr || ymd(tomorrow);
  if (fromStr > endDateStr) return out;

  const envById = new Map((envelopes || []).map(e => [e.id, e]));
  // A planned item may name the account that pays for it. Carry it only while
  // that account exists and is not archived; a dead one reads as no account,
  // so no caller charges the item's stale choice (the Forecast lens then
  // attributes the row from history, which can itself land on an archived
  // account the envelope used to be paid from; see BACKLOG).
  const liveAccountIds = new Set();
  for (const a of accounts || []) if (a && a.id && !a.archived) liveAccountIds.add(a.id);

  for (const item of budgetItems) {
    if (!item || item.as_schedule) continue;          // owned by the scheduled forecaster
    if (item.include === false) continue;
    if (isIncomeLikeItem(item)) continue;
    if (item.kind === 'account_transfer') continue;   // not spending
    if (!item.monthly_schedule) continue;
    const env = envById.get(item.envelope_id);
    if (item.envelope_id && (!env || env.archived)) continue;
    if (!item.envelope_id && item.kind && item.kind !== 'expense') continue;

    // Consumers requesting monthly buckets net actual payments first, then
    // spread undated everyday spending. Extend only those buckets through
    // month-end so a short horizon has the same daily amounts as a long one.
    const undated = !(Number(item.payment_day) >= 1);
    const spread = !!opts.monthlyBuckets && undated && resolveFundingStyle(item) === 'spending';
    const payDay = undated ? 31 : item.payment_day;
    const [endYear, endMonth] = endDateStr.split('-').map(Number);
    const bucketEnd = spread ? ymd(new Date(endYear, endMonth, 0)) : endDateStr;
    const bounds = itemDateBounds(item);

    const occurrences = walkMonthlySchedule({
      months: item.monthly_schedule,
      payment_day: payDay,
      // The item's dates bound the plan: an ENDED item (a salary, a
      // fixed-term cost) must stop being planned, not just stop auto-posting,
      // and one that has not started is not charged yet. The stamped
      // `as_schedule_since` stays deliberately out: a plan item is charged
      // for the whole window regardless of when auto-posting started.
      since: itemDateBounds(item).since,
      until: spread && bounds.until ? `${bounds.until.slice(0, 7)}-31` : bounds.until,
      skipped: item.skipped_occurrences,
    }, fromStr, bucketEnd, { dayType: spread ? 'exact' : item.schedule_day_type, country });

    for (const occ of occurrences) {
      // Per-month override wins over default_amount, matching
      // computeScheduledOccurrences and buildExpenseCalendar.
      const monIdx = Number(occ.monthKey.slice(5, 7)) - 1;
      const val = item.monthly_schedule[MONTH_NAMES[monIdx]];
      const amt = typeof val === 'number' ? val : (item.default_amount ?? 0);
      if (Math.abs(amt) < CENT_EPSILON) continue;

      out.push({
        id: `planned:${item.id}:${occ.monthKey}`,
        is_forecast: true,
        is_planned: true,
        ...(opts.monthlyBuckets ? { forecast_spread: spread, forecast_undated: undated,
          forecast_spread_since: bounds.since, forecast_spread_until: bounds.until } : {}),
        forecast_budget_item_id: item.id,
        forecast_month_key: occ.monthKey,
        forecast_dedup_key: `${item.id}:${occ.monthKey}`,
        // Fill % style: a bill's row is settled outright by a payment linked
        // to the item, a spending row only reduced (netAgainstSpentThisMonth).
        forecast_bill: resolveFundingStyle(item) === 'bill',
        type: 'expense',
        date: occ.date,
        status: 'scheduled',
        amount: Math.abs(amt),
        envelope_id: item.envelope_id,
        account: item.account_id && liveAccountIds.has(item.account_id) ? item.account_id : null,
        payee: item.description || env?.name || '',
        note: null,
      });
    }
  }
  return out;
}

/**
 * The dedup key of a forecast row — the string that matches the `from_budget`
 * its real counterpart carries once posted.
 *
 * Every forecast consumer needs this, and composing it by hand is a live trap:
 * `${forecast_budget_item_id}:${forecast_month_key}` is right only for the
 * expense/income/investment legs. A fill's key is not the item:month pair (the
 * income-linked one appends `:fill`, a self-scheduled one is namespaced `tpl:`
 * and has no budget item at all), so a hand-composed key silently fails to
 * match and the row gets counted twice — once real, once forecast.
 */
export function forecastKey(row) {
  if (!row) return '';
  if (row.forecast_dedup_key) return row.forecast_dedup_key;
  return `${row.forecast_budget_item_id}:${row.forecast_month_key}`;
}

/**
 * Every forecast fill over one window.
 *
 * There used to be two sources — income-linked templates and self-scheduled
 * ones — and this existed so callers could not forget the second. The
 * income-linked leg is gone (templates carry their own calendar now, which
 * does everything it did and keeps firing in a month whose income is zero),
 * so this is a single delegation. It stays as the name every caller already
 * uses, and as the place a second source would go if one ever returns.
 *
 * opts: { fromDateStr?: string, country?: string }
 */
export function forecastAllFills(budgetItems, envelopeTemplates, accounts, envelopes, today, endDateStr, opts = {}) {
  return [
    ...forecastTemplateFills(envelopeTemplates, budgetItems, envelopes, today, endDateStr, opts),
  ];
}

/**
 * How many envelopes a fill row SETS to a value rather than adds to. Those
 * lines are left out of `fillDisplayTotal` (an overwrite is not a
 * contribution), so a surface showing that total must say they exist, or a
 * template mixing both looks smaller than what it moves. Owner decision
 * 2026-09-29: show the added total plus a "sets N" note.
 *
 * @param {any} row
 * @returns {number}  0 for anything that is not a fill
 */
export function fillSetLineCount(row) {
  if (!row || row.type !== 'fill' || !Array.isArray(row.lines)) return 0;
  return row.lines.filter((l) => l && l.mode === 'set').length;
}

/**
 * Total a fill row moves into envelopes, for display. `set`-mode lines are
 * excluded: a set line overwrites a balance rather than contributing its
 * amount, so summing it as a contribution is a category error. The offsetting
 * negative line on a source-funded fill (`source_envelope_id`, or a manual
 * `--from-envelope` fill — same shape) is excluded too: abs-summing it
 * displayed a sourced fill at exactly DOUBLE the money that moves into
 * envelopes. A resolved set line counts with its sign, so a fill that hands a
 * surplus back nets it out (and can total below zero). Returns 0 for anything
 * that is not a fill.
 */
export function fillDisplayTotal(row) {
  if (!row || row.type !== 'fill' || !Array.isArray(row.lines)) return 0;
  const srcId = row.source_envelope_id || null;
  let sum = 0;
  for (const l of row.lines) {
    if (!l || l.mode === 'set') continue;
    if (srcId && l.envelope_id === srcId && Number(l.amount) < 0) continue;
    // A resolved set line (`set_target`, see `storedFillLines`) is a signed
    // delta: negative when the envelope held more than its target and the
    // surplus went back. Its magnitude would show that return as money added.
    sum += l.set_target !== undefined ? (Number(l.amount) || 0) : Math.abs(Number(l.amount) || 0);
  }
  return round2(sum) || 0;
}

/**
 * Per-envelope "upcoming" delta driving the envelope card's hint
 * (`incl. €X upcoming`). Returns Map<envelope_id, delta>, with only
 * materially non-zero entries (|delta| > CENT_EPSILON).
 *
 * Combines two sources, both signed like `computeEnvelopeBalances`
 * (negative = net debit / money leaves the envelope):
 *   1. All real future-dated transactions (any date) — what's already
 *      manually committed.
 *   2. Scheduled-forecast rows from tomorrow through end of the current
 *      month, deduped against real txs that already settled the same
 *      `${budget_item_id}:${month_key}` occurrence.
 *
 * The end-of-month cap on (2) keeps the projection bounded so a
 * one-sided forecast (expenses without matching synthetic fills) can't
 * drive envelopes deeply negative the way 12-month projection did in
 * the reverted PR #62.
 */
export function computeEnvelopeUpcomingDeltas(transactions, budgetItems, accounts, envelopes, today, country = 'FI', envelopeTemplates = []) {
  const txs = transactions || [];
  const balanceAll = computeEnvelopeBalances(txs);
  const balanceNow = computeEnvelopeBalances(txs, { asOf: today });

  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const endStr = ymd(endOfMonth);

  const forecasts = forecastScheduledTransactions(
    budgetItems || [],
    accounts || [],
    envelopes || [],
    today,
    endStr,
    null,
    country,
    { transactions: txs },
  );

  // Both fill legs, or the hint counts only the money LEAVING an envelope this
  // month. An envelope funded on the 1st and spent through the month otherwise
  // reads as far more negative than it will actually be.
  const fills = forecastAllFills(
    budgetItems || [], envelopeTemplates || [], accounts || [], envelopes || [],
    today, endStr, { country },
  );

  // Drop forecast rows whose underlying occurrence has already been posted as
  // a real tx (which then carries `from_budget`). Fill rows carry an explicit
  // `forecast_dedup_key` because their key is not the item:month pair — see
  // `forecastKey()` in envelope-forecast.js, which this mirrors.
  const taken = new Set();
  for (const tx of txs) {
    if (tx && typeof tx.from_budget === 'string') taken.add(tx.from_budget);
  }
  const freshForecasts = forecasts.filter(f => !taken.has(forecastKey(f)));
  const forecastBalance = computeEnvelopeBalances(freshForecasts);

  // Fill lines are summed directly rather than run through
  // `computeEnvelopeBalances`, because a `set`-mode line does not contribute
  // its amount — it overwrites the balance, and expressing that as a delta
  // needs the balance it will overwrite. Add-mode lines are a clean delta;
  // set-mode ones are left out rather than counted as if they added. The
  // funding source of a set line follows suit: an unresolved
  // (`source_set_pending`) source line carries only the add part, so the
  // hint leaves out the set part on BOTH sides of the fill.
  const fillDeltas = new Map();
  for (const row of fills) {
    if (taken.has(forecastKey(row))) continue;
    for (const line of row.lines || []) {
      if (!line || line.mode === 'set' || !line.envelope_id) continue;
      // SIGNED: a source-funded template fill carries one negative add-line
      // on the envelope it draws from. Abs-ing it turned that envelope's
      // monthly drain into a phantom top-up of the same size.
      const amt = Number(line.amount) || 0;
      if (amt === 0) continue;
      fillDeltas.set(line.envelope_id, (fillDeltas.get(line.envelope_id) || 0) + amt);
    }
  }

  const out = new Map();
  const ids = new Set([
    ...balanceAll.keys(),
    ...balanceNow.keys(),
    ...forecastBalance.keys(),
    ...fillDeltas.keys(),
  ]);
  for (const id of ids) {
    const realFuture = (balanceAll.get(id) || 0) - (balanceNow.get(id) || 0);
    const forecast = forecastBalance.get(id) || 0;
    const sum = realFuture + forecast + (fillDeltas.get(id) || 0);
    if (Math.abs(sum) > CENT_EPSILON) out.set(id, sum);
  }
  return out;
}
