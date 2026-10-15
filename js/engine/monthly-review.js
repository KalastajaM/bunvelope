// js/engine/monthly-review.js — annual / monthly planning math, emergency-fund
// requirement, and the per-month review row builder.
//
// `runMonthlyReview` is the workhorse the dashboard and review pages use to
// flag over/under spending and project end-of-month balances.
// `rollForwardEnvelopeBalances` chains it across months to project an
// envelope's balance at any future month-start.
//
// Pure functions. No DOM, no I/O.

import { parseDate, round2, validateAmount } from '../utils.js';
import { MONTH_NAMES, isIncomeLikeItem, CENT_EPSILON, requireClock, LINK_DAY_WINDOW, settles, resolveFundingStyle, txLinkedItemId } from './_constants.js';
import { computeEnvelopeBalances, txEnvelopeIds, txEnvelopeSpend, txEnvelopeEffect } from './balances.js';
import { txAbsAmount, txDirection } from './tx-amounts.js';
import { planItemsAsOf, monthStartDate } from './item-dates.js';

/** Whether a row names a budget item, itself or on any split line. @param {any} tx */
function hasItemLink(tx) {
  if (typeof tx?.budget_item_id === 'string' && tx.budget_item_id) return true;
  return Array.isArray(tx?.envelope_splits)
    && tx.envelope_splits.some(s => typeof s?.budget_item_id === 'string' && s.budget_item_id);
}

// ─── Annual / monthly planning math ──────────────────────────────────────────

/**
 * Annual planned amount for a single budget item. Sums each month's scheduled
 * amount (literal number, or `default_amount` when the month flag is `true`)
 * plus any `extra_buffer`. All magnitudes — sign is ignored; callers decide
 * how to interpret income vs expense.
 */
export function computeAnnual(item) {
  // A balance target is not a recurring amount; estimates come from the forecast.
  if (item?.kind === 'account_transfer' && item.transfer_mode === 'target_balance') return 0;
  if (!item || !item.monthly_schedule) return 0;
  let total = 0;
  for (const mon of MONTH_NAMES) {
    const val = item.monthly_schedule[mon];
    if (val === true) {
      total += Math.abs(item.default_amount ?? 0);
    } else if (typeof val === 'number' && val !== 0) {
      total += Math.abs(val);
    }
  }
  total += Math.abs(item.extra_buffer ?? 0);
  return total;
}

/**
 * Split included budget items by `kind` and return their yearly totals plus
 * the income − budget difference (positive = surplus, negative = deficit).
 * An `account_transfer` is neither: moving money between your own accounts
 * does not change what you have.
 */
export function computeAnnualTotals(budgetItems) {
  const included = (budgetItems || []).filter(it => it.include !== false && it.kind !== 'account_transfer');
  const income = included
    .filter(isIncomeLikeItem)
    .reduce((sum, it) => sum + computeAnnual(it), 0);
  const budget = included
    .filter(it => !isIncomeLikeItem(it))
    .reduce((sum, it) => sum + computeAnnual(it), 0);
  return { income, budget, diff: income - budget };
}

/**
 * Annual planned totals grouped by envelope. Sum of `computeAnnual(item)`
 * (i.e. monthly_schedule + extra_buffer) across all included, non-income
 * items that map to each envelope. Returns Map<envelope_id, number>.
 */
export function annualByEnvelope(budgetItems) {
  const out = new Map();
  for (const it of budgetItems || []) {
    if (!it || it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    if (!it.envelope_id) continue;
    out.set(it.envelope_id, (out.get(it.envelope_id) || 0) + computeAnnual(it));
  }
  return out;
}

/**
 * Resolve a dynamic template's effective fill lines against the current budget.
 * For each assignment `{ envelope_id, mode, percent }`, amount = monthly plan × pct,
 * where the monthly plan is `computeMonthlyPlanByEnvelope` (annual schedule ÷ 12).
 * Returns [] for manual templates. Assignments with zero monthly plan are skipped.
 *
 * Deliberately NOT `annualByEnvelope / 12`: that includes `extra_buffer`, which
 * is a one-off balance FLOOR, not recurring spend. Spreading it across every
 * monthly fill overfunds the envelope by buffer/12 each month, forever, and
 * double-counts against `calcDepositAndRequired`, which already adds the buffer
 * to the required reserve separately.
 */
export function computeDynamicTemplateLines(template, budgetItems) {
  if (!template || template.kind !== 'dynamic') return [];
  const monthlyPlan = computeMonthlyPlanByEnvelope(budgetItems);
  const lines = [];
  for (const a of (template.assignments || [])) {
    if (!a || !a.envelope_id) continue;
    const base = monthlyPlan.get(a.envelope_id) || 0;
    const pct = Number(a.percent ?? 100) / 100;
    const amount = round2(base * pct);
    if (amount <= 0) continue;
    // A `set` assignment keeps its mode: `amount` is then the TARGET the
    // envelope is topped up to (plan × pct), not money added. Every consumer
    // resolves it the same way a manual template's set line is resolved — a
    // posted fill overwrites the balance, the forecast walk lands the walked
    // balance on the target (delta = target − balance), and a funding source
    // draws that delta (see `templateFillLines` in scheduling.js).
    lines.push({
      envelope_id: a.envelope_id,
      mode: a.mode === 'set' ? 'set' : 'add',
      amount,
    });
  }
  return lines;
}

/**
 * Template-agnostic line resolver. Returns the effective fill lines for a
 * template: static `lines` for manual, computed lines for dynamic.
 */
export function resolveTemplateLines(template, budgetItems) {
  if (!template) return [];
  if (template.kind === 'dynamic') return computeDynamicTemplateLines(template, budgetItems);
  return Array.isArray(template.lines) ? template.lines : [];
}

/**
 * Monthly average planned amount per envelope (annual ÷ 12).
 * Respects `monthly_schedule` (numbers or true/false) and `default_amount`.
 * Skips `include: false` and income items. Does NOT include `extra_buffer`,
 * which is a balance floor rather than a recurring spend.
 * Returns Map<envelope_id, number>.
 */
export function computeMonthlyPlanByEnvelope(budgetItems) {
  const cal = buildExpenseCalendar(budgetItems);
  const out = new Map();
  for (const [envId, arr] of cal) {
    let sum = 0;
    for (let i = 1; i <= 12; i++) sum += arr[i] || 0;
    out.set(envId, round2(sum / 12));
  }
  return out;
}

/**
 * Build an expense calendar from budget items.
 * Returns Map<envelope_id, number[13]> where index 1..12 are the months
 * (Jan..Dec). N items under the same envelope_id are summed.
 * Items with `include === false` are skipped.
 */
export function buildExpenseCalendar(budgetItems) {
  const cal = new Map();
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    const id = it.envelope_id;
    if (!id) continue;
    if (!cal.has(id)) cal.set(id, new Array(13).fill(0));
    const arr = cal.get(id);
    const sched = it.monthly_schedule || {};
    MONTH_NAMES.forEach((m, i) => {
      const calIdx = i + 1;
      const v = sched[m];
      if (v === undefined || v === false) return;
      const amt = typeof v === 'number' ? Math.abs(v) : Math.abs(it.default_amount || 0);
      if (amt > 0) arr[calIdx] += amt;
    });
  }
  return cal;
}

/**
 * Convert calendar entry (array[1..12]) to rolling window starting at curM.
 * Position 1 in result = current month.
 * @param {number[]} eCalEntry - array[0..12], indices 1–12 used
 * @param {number} curM - current month (1-based)
 */
export function toRollingSchedule(eCalEntry, curM) {
  const roll = new Array(13).fill(0);
  for (let pos = 1; pos <= 12; pos++) {
    const calM = ((curM - 1 + pos - 1) % 12) + 1;
    roll[pos] = eCalEntry[calM];
  }
  return roll;
}

/**
 * Compute monthly deposit D and required balance from a rolling schedule.
 * `buffer` is the envelope's total extra_buffer floor — added to `req` so the
 * envelope must stay at least `buffer` above zero at all times.
 * @param {number[]} eRoll - rolling array[1..12], position 1 = current month
 * @param {number} [buffer=0] - balance floor (non-negative)
 * @returns {{ D: number, req: number }}
 */
export function calcDepositAndRequired(eRoll, buffer = 0) {
  const C = new Array(13).fill(0);
  for (let m = 1; m <= 12; m++) C[m] = C[m - 1] + eRoll[m];
  const annual = C[12];
  // §2.3 — take the ceiling in integer cents, not on a float.
  // `annual` is a running sum of twelve schedule cells, so
  // `annual / 12 * 100` lands a hair above an exact integer often enough to
  // matter: `Math.ceil` then rounds up a cent the schedule does not require,
  // permanently, and `startNext` (projected + D) inherits it. Measured on the
  // owner's budget, 24 envelope×month pairs were one cent high — 2 envelopes,
  // in every one of the twelve reference months.
  //
  // `Math.round(annual * 100)` is the honest cent value of the sum; the
  // ceiling then operates on an integer. `req` below is deliberately NOT
  // given the same treatment — it already rounds, and moving both figures at
  // once makes the review harder to eyeball against the numbers the owner has
  // been reading.
  const D = Math.ceil(Math.round(annual * 100) / 12) / 100;
  // Required at start of next month (pos 2), before deposit
  // max(C[k] - C[1] - (k-1)*D) for k=2..12
  let req = 0;
  for (let k = 2; k <= 12; k++) {
    const shortfall = C[k] - C[1] - (k - 1) * D;
    if (shortfall > req) req = shortfall;
  }
  req = Math.max(0, Math.round(req * 100) / 100);
  req = round2(req + Math.abs(buffer || 0));
  return { D, req };
}

/**
 * Aggregate `extra_buffer` per envelope across included (non-income) items.
 * Returns Map<envelope_id, number>.
 */
export function computeBufferByEnvelope(budgetItems) {
  const out = new Map();
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    if (!it.envelope_id) continue;
    const b = Math.abs(it.extra_buffer || 0);
    if (b > 0) out.set(it.envelope_id, (out.get(it.envelope_id) || 0) + b);
  }
  return out;
}

// ─── Emergency budget helper ─────────────────────────────────────────────────

/**
 * Sum the monthly expense amounts for all budget items flagged
 * `include_in_emergency_budget`, for a given month (1-based).
 * @param {Array}  budgetItems
 * @param {number} curM - 1-based month index
 * @returns {number}
 */
export function computeMonthlyEmergencyAmount(budgetItems, curM) {
  const monthName = MONTH_NAMES[curM - 1];
  let total = 0;
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    if (!it.include_in_emergency_budget) continue;
    const sched = it.monthly_schedule || {};
    const v = sched[monthName];
    if (v === undefined || v === false) continue;
    const amt = typeof v === 'number' ? Math.abs(v) : Math.abs(it.default_amount || 0);
    total += amt;
  }
  return total;
}

// ─── Full monthly review ─────────────────────────────────────────────────────

/**
 * Build, per envelope, an array[1..12] of additional debits coming from
 * already-booked transactions (manual future-dated entries) over the rolling
 * 12-month window starting at `curM`/`curYear`. Position 1 = the review's
 * current month, position 12 = +11 months. These extras are added to the
 * planned-from-budget rolling schedule before `calcDepositAndRequired` so the
 * required-reserve figure surfaces top-up needs caused by one-off bookings.
 *
 * Skipped:
 *   - `is_forecast` rows (in-memory only; the underlying budget item is
 *     already represented in eRoll via the monthly schedule)
 *   - rows with `from_budget` (materialised scheduled budget items, also
 *     already in eRoll — would double-count)
 *   - past-dated rows (already deducted from `balance`; not "upcoming"), and
 *     posted rows dated today, which the review counts as `actual`
 *
 * Counted: `expense` (single + splits), `debt_payment`, `investment_transfer`
 * with direction `buy` — i.e. anything that debits the envelope. Splits are
 * signed; only positive debit lines contribute to the required-reserve bump
 * (negative correction lines do not increase need).
 *
 * Also skipped, or only partly counted: a booked row that IS the payment of
 * a planned item that month, which `eRoll` already holds (rent typed in
 * ahead). Counting it again doubled the rent in `planned`, `D` and `required`
 * (2026-10-01). A row is a planned payment when, for an item of its envelope
 * with an occurrence in the row's month, it is
 *   - linked to the item (`budget_item_id`): a bill's whole payment is
 *     covered (an invoice above or below its estimate is still the invoice);
 *     a spending item's plan covers the row up to what is left of it;
 *   - or unlinked and `settles()` a bill's occurrence: the exact amount within
 *     the link window of its due date (`payment_day`, clamped to the month).
 * Each bill occurrence is paid once. Anything else stays a full extra: a
 * one-off on top of the plan is exactly what this is for.
 *
 * A row that pays NEXT month's bill early (rent for 3 Nov typed in, dated
 * 28 Oct) is cash leaving this month, so it is added here, and the next
 * month's position is reduced by that bill (a negative entry; the caller
 * floors each month at zero). The bill moves a month earlier instead of
 * being in the schedule twice: the year's total, and so `D`, is unchanged,
 * and `required` stops reserving for a bill already paid. A row in the last
 * position has no next month in the window and stays a plain extra.
 */
function _bookedFutureExtrasByEnvelope(transactions, curYear, curM, refDate, budgetItems = []) {
  const out = new Map();
  requireClock(refDate, 'runMonthlyReview');

  // Planned occurrences a booked row can be the payment of, per envelope and
  // month, built on demand.
  const pad = n => String(n).padStart(2, '0');
  const paidOcc = new Set();          // `${itemId}:${YYYY-MM}` of bills paid by a booked row
  const spendingLeft = new Map();     // `${itemId}:${YYYY-MM}` -> plan left for a spending item
  const occurrences = (envelopeId, y, m) => {
    const monthName = MONTH_NAMES[m - 1];
    const lastDay = new Date(y, m, 0).getDate();
    const list = [];
    for (const it of budgetItems || []) {
      if (!it || it.envelope_id !== envelopeId || it.include === false) continue;
      // Auto-post items too: a bill paid by hand ahead is not posted again
      // (the duplicate-post guard), and `eRoll` holds its plan all the same.
      if (isIncomeLikeItem(it) || it.kind === 'account_transfer') continue;
      const v = it.monthly_schedule?.[monthName];
      if (v === undefined || v === false) continue;
      const amount = Math.abs(typeof v === 'number' ? v : (it.default_amount || 0));
      if (!(amount > 0)) continue;
      const day = Math.min(Math.max(1, Number(it.payment_day) || 1), lastDay);
      list.push({
        item: it, amount, bill: resolveFundingStyle(it) === 'bill',
        date: `${y}-${pad(m)}-${pad(day)}`, key: `${it.id}:${y}-${pad(m)}`,
      });
    }
    return list;
  };
  // How much of a booked row is a planned payment `eRoll` already counts.
  const plannedPart = (tx, envelopeId, amount, tDate) => {
    if (!envelopeId || !(amount > 0)) return 0;
    const list = occurrences(envelopeId, tDate.getFullYear(), tDate.getMonth() + 1);
    if (!list.length) return 0;
    const dateStr = `${tDate.getFullYear()}-${pad(tDate.getMonth() + 1)}-${pad(tDate.getDate())}`;
    const linkId = txLinkedItemId(tx, null, envelopeId);
    if (linkId) {
      const occ = list.find(o => o.item.id === linkId);
      if (!occ) return 0;
      if (occ.bill) {
        if (paidOcc.has(occ.key)) return 0;
        paidOcc.add(occ.key);
        return amount;
      }
      const left = spendingLeft.has(occ.key) ? spendingLeft.get(occ.key) : occ.amount;
      const take = Math.min(left, amount);
      spendingLeft.set(occ.key, round2(left - take));
      return take;
    }
    const occ = list.find(o => o.bill && !paidOcc.has(o.key)
      && settles({ date: dateStr, amount }, { date: o.date, amount: o.amount }));
    if (!occ) return 0;
    paidOcc.add(occ.key);
    return amount;
  };
  // The amount of NEXT month's bill this booked row pays early (rent dated
  // 28 Oct for 3 Nov), or 0. Same `settles()` rule: linked at any amount, or
  // unlinked at the exact amount, within the link window of the due date.
  const paysNextMonthsBill = (tx, envelopeId, amount, tDate) => {
    if (!envelopeId || !(amount > 0)) return 0;
    const next = new Date(tDate.getFullYear(), tDate.getMonth() + 1, 1);
    const list = occurrences(envelopeId, next.getFullYear(), next.getMonth() + 1).filter(o => o.bill);
    if (!list.length) return 0;
    const dateStr = `${tDate.getFullYear()}-${pad(tDate.getMonth() + 1)}-${pad(tDate.getDate())}`;
    const linkId = txLinkedItemId(tx, null, envelopeId);
    const occ = list.find(o => !paidOcc.has(o.key)
      && settles({ date: dateStr, amount, itemId: linkId }, { date: o.date, amount: o.amount, itemId: o.item.id }));
    if (!occ) return 0;
    paidOcc.add(occ.key);
    return occ.amount;
  };
  const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const startKey = curYear * 12 + (curM - 1);

  const addAt = (envId, pos, amt) => {
    if (!envId || envId === '__none__') return;
    const a = validateAmount(amt);
    if (a === null) return;
    let arr = out.get(envId);
    if (!arr) { arr = new Array(13).fill(0); out.set(envId, arr); }
    arr[pos] += Math.abs(a);
  };
  // A planned bill already paid a month early: negative, and the caller floors
  // the month's schedule at zero.
  const subtractAt = (envId, pos, amt) => {
    let arr = out.get(envId);
    if (!arr) { arr = new Array(13).fill(0); out.set(envId, arr); }
    arr[pos] -= amt;
  };

  for (const tx of transactions || []) {
    if (!tx) continue;
    if (tx.is_forecast) continue;
    if (tx.from_budget) continue;

    const type = tx.type;
    if (type !== 'expense' && type !== 'debt_payment' && type !== 'investment_transfer') continue;

    const tDate = parseDate(tx.date);
    if (!tDate) continue;
    if (tDate < today) continue;
    // Same rule as runMonthlyReview's own bucketing: a row is upcoming only
    // when it is scheduled or dated after today. A posted row dated today is
    // actual spend — counting it here as well folded it into `planned` too,
    // and at midnight it dropped out again, moving `projected` and
    // `required` overnight with no new data.
    if (tDate.getTime() === today.getTime() && (tx.status || '') !== 'scheduled') continue;

    const txKey = tDate.getFullYear() * 12 + tDate.getMonth();
    const pos = txKey - startKey + 1;
    if (pos < 1 || pos > 12) continue;

    if (type === 'expense') {
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        // Each line as its own expense in its envelope: a line linked to an
        // item (or matching a bill) is that payment, like a single row.
        for (const s of tx.envelope_splits) {
          const sa = validateAmount(s.amount);
          if (sa === null || !(sa > 0)) continue;
          const own = plannedPart(tx, s.envelope_id, sa, tDate);
          addAt(s.envelope_id, pos, round2(sa - own));
          if (own === 0 && pos < 12) {
            const ahead = paysNextMonthsBill(tx, s.envelope_id, sa, tDate);
            if (ahead > 0) subtractAt(s.envelope_id, pos + 1, ahead);
          }
        }
      } else {
        const amount = txAbsAmount(tx);
        const own = plannedPart(tx, tx.envelope_id, amount, tDate);
        if (own > 0) {
          addAt(tx.envelope_id, pos, round2(amount - own));
        } else {
          // Not a payment of this month's plan: the cash leaves this month
          // either way. If it is NEXT month's bill paid early, that bill moves
          // a month earlier in the schedule instead of being counted twice.
          addAt(tx.envelope_id, pos, amount);
          if (pos < 12) {
            const ahead = paysNextMonthsBill(tx, tx.envelope_id, amount, tDate);
            if (ahead > 0) subtractAt(tx.envelope_id, pos + 1, ahead);
          }
        }
      }
    } else if (type === 'debt_payment') {
      addAt(tx.envelope_id, pos, txAbsAmount(tx));
    } else if (type === 'investment_transfer') {
      if (txDirection(tx) === 'buy') addAt(tx.envelope_id, pos, txAbsAmount(tx));
    }
  }
  return out;
}

/**
 * Per envelope, how much of month `month`'s planned BILLS was already paid in
 * the link window before the 1st: rent paid 28 Sep for 3 Oct. Entries dated
 * ahead count too, which is what a future month needs (rent for 3 Nov typed
 * in now, dated 28 Oct); for the current month the window is past anyway.
 *
 * A payment counts for a bill item of the envelope with an occurrence this
 * month when it carries the occurrence's `from_budget` key (`item:YYYY-MM`),
 * or it `settles()` the occurrence: linked to the item (`budget_item_id`) at
 * any amount, or unlinked at the exact amount, within the link window. The
 * same rule the forecast and fill % use. Each payment and each item is used
 * once; the amount counted is the item's plan for the month.
 *
 * The due date is `payment_day` clamped to the month, without the
 * working-day shift: this module cannot import the scheduling walker (it
 * imports this one), and a shift of a day or two sits well inside the window.
 * Bills only: a groceries purchase on 29 Sep is September's spending.
 *
 * Returns `envelopeId => number`, memoized per envelope.
 */
function _earlyPaidBills(budgetItems, transactions, month) {
  const [y, m] = month.split('-').map(Number);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthStart = `${month}-01`;
  const lookback = ymd(new Date(y, m - 1, 1 - LINK_DAY_WINDOW));
  const lastDay = new Date(y, m, 0).getDate();
  const monthName = MONTH_NAMES[m - 1];

  // Real rows from the window before the 1st, linked ones first so a link
  // wins over an amount look-alike.
  const candidates = (transactions || []).filter(tx => {
    if (!tx || tx.is_forecast) return false;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    return d >= lookback && d < monthStart;
  }).sort((a, b) => Number(!hasItemLink(a)) - Number(!hasItemLink(b)));

  const cache = new Map();
  return (envelopeId) => {
    if (cache.has(envelopeId)) return cache.get(envelopeId);
    let total = 0;
    if (candidates.length) {
      const used = new Set();
      for (const it of budgetItems || []) {
        if (!it || it.envelope_id !== envelopeId || it.include === false) continue;
        if (isIncomeLikeItem(it) || it.kind === 'account_transfer') continue;
        if (resolveFundingStyle(it) !== 'bill') continue;
        const v = it.monthly_schedule?.[monthName];
        if (v === undefined || v === false) continue;
        const amount = Math.abs(typeof v === 'number' ? v : (it.default_amount || 0));
        if (!(amount > 0)) continue;
        const day = Math.min(Math.max(1, Number(it.payment_day) || 1), lastDay);
        const occ = { date: `${month}-${pad(day)}`, amount, itemId: it.id };
        const key = `${it.id}:${month}`;
        const match = candidates.find(tx => {
          if (used.has(tx)) return false;
          const spent = txEnvelopeSpend(tx, envelopeId);
          if (!(spent > 0)) return false;
          if (typeof tx.from_budget === 'string' && tx.from_budget) return tx.from_budget === key;
          const linkId = txLinkedItemId(tx, null, envelopeId);
          return settles({ date: tx.date.slice(0, 10), amount: round2(spent), itemId: linkId }, occ);
        });
        if (match) {
          used.add(match);
          total += amount;
        }
      }
    }
    total = round2(total);
    cache.set(envelopeId, total);
    return total;
  };
}

/**
 * Run the monthly review for a given month.
 *
 * @param {Array}  envelopes        - bucket entries
 * @param {Array}  budgetItems      - regular-expense items
 * @param {Map<string, number>} envelopeBalances - as-of-`refDate` balance per envelope.
 *   MUST be computed with `{ asOf: refDate }` (or rolled forward from
 *   such a map via `rollForwardEnvelopeBalances`). The budget-view map
 *   (no `asOf`) already includes future-dated tx and would cause
 *   the projection to double-count them: future fills are added here and
 *   future-dated/forecast debits are included via `scheduled`.
 * @param {Array}  transactions     - all transactions
 * @param {string} month            - "YYYY-MM"
 * @param {Date} refDate  - the clock, supplied by the caller
 * @returns {Array} rows sorted by category+name
 */
export function runMonthlyReview(envelopes, budgetItems, envelopeBalances, transactions, month, refDate) {
  // The plan as the reviewed month sees it: an item that ended in December
  // still counts when December is reviewed in January.
  budgetItems = planItemsAsOf(budgetItems || [], monthStartDate(month));
  const [yearStr, monthStr] = month.split('-');
  const curYear = parseInt(yearStr, 10);
  const curM    = parseInt(monthStr, 10);

  const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());

  const envelopeById = new Map();
  for (const env of envelopes || []) envelopeById.set(env.id, env);

  // Actual (past/today) and planned (future-dated or scheduled) debits per envelope_id for this month
  const actualDebits    = new Map();
  const scheduledDebits = new Map();
  const futureFills = new Map();
  const walkedBalances = new Map(envelopeBalances);

  // Walk dated spending and fills together: a Set is a target balance, not
  // an additional deposit. Posted fills through today are already in the
  // opening balance. Effective transactions have already deduped templates.
  for (const tx of [...transactions].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const d = parseDate(tx.date);
    if (!d || d.getFullYear() !== curYear || d.getMonth() + 1 !== curM) continue;
    const planned = tx.status === 'scheduled' || !!tx.is_forecast || d > today;
    if (!planned) continue;
    for (const id of txEnvelopeIds(tx)) {
      const before = walkedBalances.get(id) ?? 0;
      if (tx.type === 'fill') {
        // Stored rows through today are already in the as-of balance, even
        // when still scheduled; generated rows are not in that balance.
        if (d <= today && !tx.is_forecast) continue;
        const effect = txEnvelopeEffect(tx, id);
        if (!effect) continue;
        const delta = effect.mode === 'set' ? effect.value - before : effect.amount;
        futureFills.set(id, round2((futureFills.get(id) || 0) + delta));
        walkedBalances.set(id, round2(before + delta));
      } else {
        walkedBalances.set(id, round2(before - txEnvelopeSpend(tx, id)));
      }
    }
  }

  for (const tx of transactions) {
    const status = tx.status || '';

    const tDate = parseDate(tx.date);
    if (!tDate) continue;
    if (tDate.getMonth() + 1 !== curM || tDate.getFullYear() !== curYear) continue;

    const isPlanned = status === 'scheduled' || !!tx.is_forecast || tDate > today;
    const bucket = isPlanned ? scheduledDebits : actualDebits;

    // `txEnvelopeSpend` owns which types count as spending and how splits are
    // signed; this loop only decides which bucket the money lands in. It used
    // to carry its own per-type walk — a near-copy of the balance walkers that
    // was NOT actually the same rules (no fills, no transfers, no adjustments,
    // no investment sells), which is exactly how a "fourth copy" hides.
    for (const envId of txEnvelopeIds(tx)) {
      const spent = txEnvelopeSpend(tx, envId);
      if (spent === 0) continue;
      // Include spending on an initially empty envelope when a future fill
      // funds it; otherwise preserve the no-balance-row behaviour.
      if (isPlanned && !envelopeBalances.has(envId) && !futureFills.has(envId)) continue;
      bucket.set(envId, (bucket.get(envId) || 0) + spent);
    }
  }

  const eCal = buildExpenseCalendar(budgetItems);
  const bufferByEnv = computeBufferByEnvelope(budgetItems);
  const bookedExtras = _bookedFutureExtrasByEnvelope(transactions, curYear, curM, refDate, budgetItems);
  const earlyPaidFor = _earlyPaidBills(budgetItems, transactions, month);

  // Collect all envelope_ids: union of all envelopes, ids seen in balances, ids seen in eCal
  const allIds = new Set();
  for (const env of envelopes || []) allIds.add(env.id);
  for (const id of envelopeBalances.keys()) allIds.add(id);
  for (const id of eCal.keys()) allIds.add(id);
  for (const id of bufferByEnv.keys()) allIds.add(id);
  for (const id of bookedExtras.keys()) allIds.add(id);

  const rows = [];
  for (const id of allIds) {
    const env = envelopeById.get(id);
    const category = env ? env.category : '(Unknown)';
    const envName  = env ? env.name     : `(deleted: ${id})`;

    const balance = envelopeBalances.get(id) ?? 0;
    const eCalEntry = eCal.get(id) || new Array(13).fill(0);
    const eRoll     = toRollingSchedule(eCalEntry, curM);
    // The recurring plan for THIS month, before booked extras are folded in.
    // `bookedExtras` adds future-dated rows the user has already entered so
    // the required-reserve math covers them; that is right for the reserve
    // and wrong for the spend flag, which compares against what was planned,
    // not against what is planned plus what has not happened yet.
    const plannedRecurring = eRoll[1];
    const actual    = actualDebits.get(id)    || 0;
    // Bills of this month already paid in the days before the 1st (rent paid
    // 28 Sep for 3 Oct). They are last month's `actual`, so without this the
    // whole bill read as still to come here and was counted twice.
    const earlyPaid = earlyPaidFor(id);
    const extras    = bookedExtras.get(id);
    if (extras) {
      for (let m = 1; m <= 12; m++) eRoll[m] = Math.max(0, round2(eRoll[m] + (extras[m] || 0)));
    }
    const buffer    = bufferByEnv.get(id) || 0;
    const { D, req } = calcDepositAndRequired(eRoll, buffer);

    const scheduled = scheduledDebits.get(id) || 0;
    const planned   = eRoll[1];

    // Spend flag
    //
    // §4.3 — the exemption used to be `category !== 'Return'`: a display
    // string, in one language, driving money logic. An envelope whose
    // category the owner renamed or translated silently changed its flagging
    // behaviour. It is now a per-envelope boolean, with the literal category
    // kept as a fallback so existing budgets behave identically until their
    // envelopes are edited. Measured contribution of the exemption on the
    // owner's budget: zero — all three envelopes in that category agree under
    // every lens.
    const flagExempt = env?.spend_flag_exempt === true
      || (env?.spend_flag_exempt === undefined && category === 'Return');
    // §2.4a — the dead band was a flat ±0.01, so the flag fired on rounding.
    // On a real budget that is nearly every envelope, all the time, and a
    // colour that is always on carries almost no information. The rule
    // 02-business-rules/03-planning-and-policies.md §8.2 specifies is
    // proportional with a floor: €1 on a €40 envelope, €40 on an €800 one.
    // §2.4b — compare what has been SPENT against what was PLANNED, with
    // both sides on the same basis.
    //
    // The comparison used to be `actual + scheduled` against `planned`. The
    // flag claims to answer "have I overspent?" and folding in scheduled and
    // future-dated rows made it answer "will I?" — so an envelope that had
    // plainly underspent read `normal` because the bills still to come topped
    // it back up, which is exactly the direction the user needs to see. On
    // the owner's budget, early in a month, 7 rows read `normal` for that
    // reason alone.
    //
    // Both terms move together, though. `planned` above has `bookedExtras`
    // folded in — future-dated rows the user entered ahead of their date —
    // and `scheduled` is those same rows. Dropping `scheduled` from the left
    // while leaving the extras on the right would bias every envelope with a
    // booked future bill toward `under`, replacing one wrong answer with
    // another. So the flag compares `actual` against `plannedRecurring`: what
    // has been spent, against what this month's plan actually asks for.
    //
    // The forward-looking question keeps its own answer — `scheduled` is its
    // own column on the row, and `remaining` below still projects with it.
    const band = Math.max(1, 0.05 * Math.abs(plannedRecurring));
    let spendFlag = 'normal';
    if (!flagExempt && plannedRecurring >= 0.01) {
      if (actual > plannedRecurring + band)      spendFlag = 'over';
      else if (actual < plannedRecurring - band) spendFlag = 'under';
    }

    // Projected end-of-month: assume the larger of the still-scheduled debits
    // and the remaining-plan gap will still hit. Symmetric across under/over —
    // for over-budget rows, `planned - actual` is negative and `scheduled`
    // wins; for under-budget rows the remaining plan dominates when nothing
    // else is scheduled.
    const remaining = Math.max(scheduled, planned - actual - earlyPaid);
    const projected = balance + (futureFills.get(id) || 0) - remaining;

    const startNext = projected + D;
    // Surplus / gap = how much the projected end-of-month balance exceeds
    // (positive → surplus) or falls short of (negative → gap) the minimum
    // required reserve.
    const surplus   = projected - req;

    rows.push({
      envelope_id: id,
      category,
      envName,
      balance,
      actual,
      scheduled,
      planned,
      D,
      required: req,
      buffer,
      projected,
      startNext,
      surplus,
      spendFlag,
    });
  }

  rows.sort((a, b) => {
    const k1 = `${a.category}: ${a.envName}`;
    const k2 = `${b.category}: ${b.envName}`;
    return k1.localeCompare(k2);
  });
  return rows;
}

/**
 * Compute the minimum required balance for the configured emergency fund
 * envelope, mirroring the formula the monthly review applies:
 *
 *   required = max(0, monthlyEssentials × duration − sumOtherBalance) + buffer
 *
 * The credit term `sumOtherBalance` is gathered per `meta.emergency_credit_source`:
 *   - `'flagged'` (default): only envelopes whose budget items are flagged
 *     `include_in_emergency_budget` count toward credit (essentials-only view).
 *   - `'all'`: every envelope except the emergency envelope itself counts.
 *
 * Each contributor credits its CURRENT envelope balance, clamped at zero
 * (an over-spent envelope cannot subtract from the credit). End-of-month
 * projections are deliberately not used: in an emergency the user can pause
 * this month's planned spending and redirect those balances, so the full
 * liquid amount in each eligible envelope counts toward coverage today.
 * Negative-balance envelopes still appear in `contributors` with
 * `clamped: true` and `contribution: 0` so the dialog can show them muted.
 *
 * Returns null when no emergency envelope is configured. Otherwise returns the
 * final figure plus all intermediate values and per-row breakdowns so callers
 * can render an explanation of the calculation.
 *
 * @returns {null | {
 *   emergencyId, required, monthlyEssentials, duration, subtotal,
 *   sumOtherBalance, buffer, items, contributors, creditMode,
 * }}
 *
 * @param {object} [input]
 * @param {any[]} [input.envelopes]
 * @param {any[]} [input.budgetItems]
 * @param {any[]} [input.transactions]
 * @param {string} [input.month]
 * @param {any} [input.meta]
 * @param {Date | null} [input._refDate]  the clock, as a parameter
 */
export function computeEmergencyFundRequirement({
  envelopes,
  budgetItems,
  transactions,
  month,
  meta,
  _refDate = null,
} = {}) {
  const emergencyId = meta?.emergency_envelope_id;
  if (!emergencyId) return null;
  const duration = meta?.emergency_duration_months ?? 6;
  const creditMode = meta?.emergency_credit_source === 'all' ? 'all' : 'flagged';
  const [, monthStr] = String(month || '').split('-');
  if (!parseInt(monthStr, 10)) return null;
  // Essentials as the coming 12 months from this month see them.
  budgetItems = planItemsAsOf(budgetItems || [], monthStartDate(String(month)));

  // Average monthly essentials across the full 12-month schedule. Spreading
  // yearly (or other irregular) invoices evenly across the year prevents
  // `monthlyEssentials × duration` from multiplying a one-off cost by the
  // duration when the current month happens to contain such an invoice.
  const envelopeById = new Map();
  for (const env of envelopes || []) envelopeById.set(env.id, env);
  const items = [];
  let monthlyEssentials = 0;
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    if (!it.include_in_emergency_budget) continue;
    const sched = it.monthly_schedule || {};
    let itemAnnual = 0;
    for (const m of MONTH_NAMES) {
      const v = sched[m];
      if (v === undefined || v === false) continue;
      const amt = typeof v === 'number' ? Math.abs(v) : Math.abs(it.default_amount || 0);
      itemAnnual += amt;
    }
    if (itemAnnual === 0) continue;
    const itemMonthly = itemAnnual / 12;
    monthlyEssentials += itemMonthly;
    const env = envelopeById.get(it.envelope_id);
    items.push({
      envelope_id: it.envelope_id || null,
      envName: env ? env.name : (it.envelope_id || ''),
      description: it.description || null,
      monthlyAmount: round2(itemMonthly),
    });
  }
  monthlyEssentials = round2(monthlyEssentials);

  const eligibleEnvIds = new Set();
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    if (!it.include_in_emergency_budget) continue;
    if (it.envelope_id) eligibleEnvIds.add(it.envelope_id);
  }

  // Credit each eligible envelope's CURRENT balance (not the post-month
  // projection, which would discount this month's planned spending — money
  // that's still liquid and redirectable in an emergency). Iterate the
  // envelopes array directly so deleted/archived ids that only show up on
  // historical transactions are naturally excluded.
  const envelopeBalances = computeEnvelopeBalances(transactions || []);
  const contributors = [];
  let sumOtherBalance = 0;
  for (const env of envelopes || []) {
    if (env.archived) continue;
    if (env.id === emergencyId) continue;
    if (creditMode === 'flagged' && !eligibleEnvIds.has(env.id)) continue;
    const balance = envelopeBalances.get(env.id) ?? 0;
    const contribution = Math.max(0, balance);
    sumOtherBalance += contribution;
    contributors.push({
      envelope_id: env.id,
      envName: env.name,
      balance,
      contribution,
      // Half-cent tolerance: a balance that rounds to €0,00 should not display
      // the "excluded — negative" tag even though it's technically below zero
      // from float arithmetic.
      clamped: balance < -CENT_EPSILON,
    });
  }
  contributors.sort((a, b) => a.envName.localeCompare(b.envName));

  const bufferByEnv = computeBufferByEnvelope(budgetItems || []);
  const buffer = bufferByEnv.get(emergencyId) || 0;
  const subtotal = monthlyEssentials * duration;
  const required = Math.round(
    (Math.max(0, subtotal - sumOtherBalance) + buffer) * 100
  ) / 100;

  return {
    emergencyId,
    required,
    monthlyEssentials,
    duration,
    subtotal,
    sumOtherBalance,
    buffer,
    items,
    contributors,
    creditMode,
  };
}

/**
 * Roll envelope balances forward from the current month to the start of a
 * future month. Returns Map<envelope_id, projectedStartBalance> representing
 * what each envelope will hold at 1st of `targetMonth`, assuming scheduled
 * transactions and planned expenses play out as forecast.
 *
 * The caller must supply `effectiveTransactions`: real state.transactions
 * concatenated with forecast rows covering every month from now through the
 * end of the month BEFORE `targetMonth` (forecasts dedup'd against posted).
 *
 * If `targetMonth` ≤ current month, returns the passed-in `envelopeBalances`
 * unchanged.
 *
 * @param {any[]} envelopes
 * @param {any[]} budgetItems
 * @param {Map<string, number>} envelopeBalances
 * @param {any[]} effectiveTransactions
 * @param {string} targetMonth  'YYYY-MM'
 * @param {Date} refDate  the clock, supplied by the caller
 */
export function rollForwardEnvelopeBalances(
  envelopes, budgetItems, envelopeBalances, effectiveTransactions, targetMonth, refDate
) {
  const curMonthKey = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}`;
  if (targetMonth <= curMonthKey) return envelopeBalances;

  let balances = new Map(envelopeBalances);
  let cursor = curMonthKey;
  while (cursor < targetMonth) {
    const rows = runMonthlyReview(envelopes, budgetItems, balances, effectiveTransactions, cursor, refDate);
    const next = new Map(balances);
    // Explicit fills in the next month replace the assumed monthly deposit
    // D. They will be walked by that month's review, including Set targets.
    const [nextY, nextM] = cursor.split('-').map(Number);
    const nextDate = new Date(nextY, nextM, 1);
    const nextKey = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    const filledNext = new Set(effectiveTransactions
      .filter(tx => tx.type === 'fill' && (tx.date || '').slice(0, 7) === nextKey)
      .flatMap(txEnvelopeIds));
    for (const r of rows) next.set(r.envelope_id, filledNext.has(r.envelope_id) ? r.projected : r.startNext);
    balances = next;
    // advance cursor by one month
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(y, m, 1); // month m (1-based) + 1 → next month
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return balances;
}
