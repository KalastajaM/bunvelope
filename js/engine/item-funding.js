// js/engine/item-funding.js — how far an envelope's money covers each of its
// budget items ("fill %").
//
// An envelope holds one pot of money for several budget items: Car charging
// pays the Evenli invoice and the odd public charger; Insurances pays three
// annual premiums and a quarterly one. This module splits the envelope's
// balance across those items in a fixed order and says, per item, whether it
// will be paid on time.
//
// "On time" is the envelope's own projection (`projectEnvelopeBalance`): the
// real fills and every other expense until the due date, walked day by day.
// A bill is on track when the projected balance on its due date, after paying
// it, is still at or above the envelope's floor; short by the gap when not.
// That is the question the owner asks ("will this get paid?"), and it agrees
// with the health sheet's chart and its "Top up" advice by construction.
//
// It replaced (2026-10-01, the same day) a per-item check that gave each item
// only its own annual ÷ 12 to build up with. That ignored the shared pot: the
// fill money set aside for next November's premium pays February's in the
// meantime, so an envelope that never dips read two items "short". Funded
// still means on track, never "the full amount already saved" (owner
// decision, 2026-10-01); what changed is how on track is measured.
//
// Separately, the current balance is split across the items (this month's
// unpaid amounts first, then the buffer, then towards each bill's next full
// payment, earliest due first). That split answers "how much of this bill is
// already in the envelope" and drives the bar; it does not decide the status.
//
// Pure functions. No DOM, no I/O, no clock: `today` is a required parameter.

import { round2 } from '../utils.js';
import {
  MONTH_NAMES, CENT_EPSILON, LINK_DAY_WINDOW, isIncomeLikeItem, requireClock, resolveFundingStyle,
  loanItemsByLoanAccount, txLinkedItemId, parseFromBudgetKey,
} from './_constants.js';
import { txEnvelopeSpend } from './balances.js';
import { buildExpenseCalendar, toRollingSchedule } from './monthly-review.js';
import { planItemsAsOf } from './item-dates.js';
import { walkMonthlySchedule } from './scheduling.js';
import { settles } from './envelope-forecast.js';

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** @typedef {'bill' | 'spending'} FundingStyle */
/** @typedef {'paid' | 'funded' | 'on_track' | 'short' | 'over'} FundingStatus */

/**
 * The parts of a budget item this module reads.
 * @typedef {object} FundingItem
 * @property {string} id
 * @property {string} [envelope_id]
 * @property {string} [description]
 * @property {string} [kind]
 * @property {string} [direction]
 * @property {boolean} [include]
 * @property {boolean} [as_schedule]
 * @property {any} [monthly_schedule]
 * @property {number} [default_amount]
 * @property {number} [extra_buffer]
 * @property {number} [payment_day]
 * @property {string} [schedule_day_type]
 * @property {string} [as_schedule_since]
 * @property {string} [as_schedule_until]
 * @property {string[]} [skipped_occurrences]
 * @property {string} [funding_style]
 */

/**
 * One item's share of the envelope.
 * @typedef {object} ItemFunding
 * @property {string} itemId
 * @property {string} name
 * @property {FundingStyle} style
 * @property {number} planThisMonth   this month's planned amount (allowance for spending)
 * @property {number} spent           attributed to this item this month, up to today
 * @property {number} remaining       planThisMonth − spent, floored at 0
 * @property {number} overspent       spent − planThisMonth, floored at 0
 * @property {number} allocated       money of the envelope's balance assigned to this item now
 * @property {number | null} pct      allocated / the next payment (bill) or what is left this
 *                                    month (spending), capped at 1; null when nothing is due
 * @property {FundingStatus} status
 * @property {number} shortBy         top-up needed so the projection stays at the floor on `shortDate`
 * @property {string | null} shortDate  the due date (bill) or day (spending) the projection falls short
 * @property {{ date: string, amount: number } | null} nextDue  next unpaid occurrence
 */

/**
 * @typedef {object} EnvelopeFunding
 * @property {ItemFunding[]} items     in display order (the waterfall's due order)
 * @property {number} reserve          the envelope's extra_buffer floor
 * @property {number} reserveAllocated part of the reserve the balance covers
 * @property {number} unassigned       balance beyond this month's amounts, the reserve and
 *                                     every bill's next full payment
 * @property {number} shortfall        the largest `shortBy` among the items
 * @property {number} unlinkedSpent    untagged spend this month no item could take
 */

// `resolveFundingStyle` lives in _constants.js so the forecast rows
// (scheduling.js) can carry it without an import cycle; re-exported here,
// where callers have always found it.
export { resolveFundingStyle };


/**
 * Budget items that draw on an envelope: included, expense-side, and in it.
 * @param {FundingItem[]} budgetItems
 * @param {string} envelopeId
 * @returns {FundingItem[]}
 */
export function envelopeFundingItems(budgetItems, envelopeId) {
  return (budgetItems || []).filter(it => it
    && it.envelope_id === envelopeId
    && it.include !== false
    && !isIncomeLikeItem(it)
    && it.kind !== 'account_transfer');
}

/**
 * Due date of an item's occurrence in month `ym`, or the 1st when the item has
 * no usable payment day (it then sorts first in that month, which is harmless:
 * it only orders the waterfall).
 * @param {FundingItem} item
 * @param {string} ym
 * @param {string} country
 * @returns {string}
 */
function dueDateIn(item, ym, country) {
  const lastDay = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const occ = walkMonthlySchedule({
    months: Object.fromEntries(MONTH_NAMES.map(m => [m, true])),
    payment_day: item.payment_day,
  }, `${ym}-01`, `${ym}-${pad(lastDay)}`, { dayType: item.schedule_day_type, country });
  return occ.length ? occ[0].date : `${ym}-01`;
}

/**
 * Split one envelope's balance across its budget items.
 *
 * 1. Spend this month (rows dated from the 1st up to and including today) is
 *    attributed to items: a row's `budget_item_id`, else the item its
 *    `from_budget` key names, else an untagged row that `settles()` a bill's
 *    occurrence this month (same amount to the cent, within the link window),
 *    else the untagged pool, which goes to spending items first and then to
 *    bills in due order, each up to its plan. What is left after that is
 *    `unlinkedSpent`: it already lowered the balance, so it needs no item.
 *    A payment tied to a bill (by link, key or match) settles that month's
 *    occurrence whatever its amount; a higher invoice shows as `overspent`.
 *    A linked payment never pays another item: one linked to an item that is
 *    not in this envelope counts as `unlinkedSpent`. A bill paid within the
 *    link window before the 1st (linked, or by exact amount) settles this
 *    month without counting as this month's spend. These are the forecast's
 *    rules too (`settles()` in envelope-forecast.js), so the two agree.
 * 2. Status, from the projection. A bill is short when the projected balance
 *    at the end of its next unpaid due date is below the floor (the summed
 *    `extra_buffer`), short by that gap; a spending item with plan left or
 *    spent past it when the projection falls below the floor before the
 *    month ends; else on track. Three
 *    refinements of on track: paid (this month's occurrence is settled),
 *    funded (a bill whose whole next payment is already in the envelope, so
 *    it needs no fill) and over (a spending item has spent past its plan,
 *    and the envelope still covers it). Short wins over paid and over: a
 *    settled bill whose next payment will not be covered, or an overspent
 *    item that leaves the envelope below its floor, still needs acting on.
 * 3. The saved split: the balance handed out to this month's remaining
 *    amounts (bills by due date, then spending), then the reserve, then
 *    towards each bill's next full payment, by due date. The rest is
 *    `unassigned`.
 *
 * `balance` must be the envelope balance as of `today` (the
 * `computeEnvelopeBalances(txs, { asOf: today })` contract `runMonthlyReview`
 * uses): a future-dated bill has not left the envelope yet.
 *
 * `daily` is `projectEnvelopeBalance(...).daily` for this envelope (or the
 * same series from `computeSpareByEnvelope`). Without it there is nothing to
 * judge coverage by, and no item is reported short.
 *
 * @param {object} input
 * @param {string} input.envelopeId
 * @param {FundingItem[]} input.budgetItems
 * @param {any[]} input.transactions
 * @param {number} input.balance
 * @param {Date} input.today
 * @param {string} [input.country]
 * @param {string[]} [input.tombstones]  `from_budget` keys of deleted scheduled rows
 * @param {{ date: string, balance: number }[] | null} [input.daily]  the envelope's projection
 * @returns {EnvelopeFunding}
 */
export function computeItemFunding({
  envelopeId, budgetItems, transactions, balance, today, country = 'FI', tombstones = [], daily = null,
}) {
  const clock = requireClock(today, 'computeItemFunding');
  const todayStr = ymd(clock);
  const curYM = todayStr.slice(0, 7);
  const curM = clock.getMonth() + 1;
  const monthStart = `${curYM}-01`;
  const tomb = new Set((tombstones || []).filter(k => typeof k === 'string'));

  // The plan as the coming 12 months see it: an ended item plans nothing.
  const items = envelopeFundingItems(planItemsAsOf(budgetItems || [], clock), envelopeId);
  // A loan payment recorded by hand names its item by the loan it pays.
  const loanLinks = loanItemsByLoanAccount(budgetItems);
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const item of items) {
    const cal = buildExpenseCalendar([{ ...item, envelope_id: 'x' }]).get('x');
    if (!cal || cal.every(v => !v)) continue;
    const skipped = Array.isArray(item.skipped_occurrences) && item.skipped_occurrences.includes(curYM);
    const settledByTombstone = tomb.has(`${item.id}:${curYM}`);
    const planThisMonth = skipped || settledByTombstone ? 0 : round2(cal[curM] || 0);
    const roll = toRollingSchedule(cal, curM);
    // First future month with an occurrence, for the due order and `nextDue`.
    let aheadPos = 0;
    for (let pos = 2; pos <= 12; pos++) if (roll[pos] > 0) { aheadPos = pos; break; }
    let aheadYM = null;
    if (aheadPos) {
      const d = new Date(clock.getFullYear(), clock.getMonth() + aheadPos - 1, 1);
      aheadYM = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }
    rows.set(item.id, {
      item,
      style: resolveFundingStyle(item),
      planThisMonth,
      settledByTombstone,
      dueThisMonth: dueDateIn(item, curYM, country),
      aheadDate: aheadYM ? dueDateIn(item, aheadYM, country) : null,
      aheadAmount: aheadPos ? round2(roll[aheadPos]) : 0,
      spent: 0,
      settledByLink: false,
      allocated: 0,
    });
  }

  // ── 1. Attribute this month's spend ──────────────────────────────────────
  // Rows from the link window before the 1st are read too, for one purpose
  // only: a bill paid early (late last month) settles this month's occurrence,
  // the same look-back the forecast's `settles()` uses. They are never spend.
  const d0 = new Date(clock.getFullYear(), clock.getMonth(), 1 - LINK_DAY_WINDOW);
  const lookbackStart = ymd(d0);
  /** @type {{ date: string, amount: number, early: boolean }[]} */
  const untagged = [];
  let foreignLinked = 0;
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    if (!d || d < lookbackStart || d > todayStr) continue;
    const early = d < monthStart;
    const spent = txEnvelopeSpend(tx, envelopeId);
    if (spent === 0) continue;
    // A `from_budget` key already names its item and month; the loan-account
    // link is only for a payment recorded by hand, which carries no key.
    const keyParts = parseFromBudgetKey(tx.from_budget);
    const linkId = keyParts ? txLinkedItemId(tx, null, envelopeId) : txLinkedItemId(tx, loanLinks, envelopeId);
    const keyed = rows.get(keyParts?.itemId || '') || null;
    const linked = linkId ? (rows.get(linkId) || null) : keyed;
    if (linkId && !linked) {
      // Linked to an item that is not one of this envelope's (moved, deleted):
      // the user said which item it paid, so it never pays another one here.
      if (!early) foreignLinked = round2(foreignLinked + spent);
      continue;
    }
    if (linked) {
      // A payment tied to a bill IS that month's payment, whatever its amount
      // (an invoice that came in under or over its estimate). A `from_budget`
      // key for another month is an early or late payment of that month's.
      const keyMonth = !linkId ? keyParts?.month : curYM;
      const isBillPayment = linked.style === 'bill' && spent > 0 && keyMonth === curYM;
      if (early) {
        if (isBillPayment && settles(
          { date: d, amount: spent, itemId: linked.item.id },
          { date: linked.dueThisMonth, amount: linked.planThisMonth, itemId: linked.item.id },
        )) linked.settledByLink = true;
        continue;
      }
      linked.spent = round2(linked.spent + spent);
      if (isBillPayment) linked.settledByLink = true;
      continue;
    }
    if (spent > 0) untagged.push({ date: d, amount: spent, early });
  }
  untagged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const byDue = (a, b) => (a.dueThisMonth < b.dueThisMonth ? -1 : a.dueThisMonth > b.dueThisMonth ? 1 : 0);
  const bills = [...rows.values()].filter(r => r.style === 'bill').sort(byDue);
  const spending = [...rows.values()].filter(r => r.style === 'spending');

  let pool = 0;
  for (const pay of untagged) {
    const bill = bills.find(r => r.planThisMonth > 0 && r.spent < CENT_EPSILON && !r.settledByLink
      && settles(pay, { date: r.dueThisMonth, amount: r.planThisMonth }));
    if (pay.early) {
      if (bill) bill.settledByLink = true;
      continue;
    }
    if (bill) { bill.spent = round2(bill.spent + pay.amount); bill.settledByLink = true; }
    else pool = round2(pool + pay.amount);
  }
  for (const r of [...spending, ...bills]) {
    if (pool <= 0) break;
    const room = round2(r.planThisMonth - r.spent);
    if (room <= 0) continue;
    const take = Math.min(room, pool);
    r.spent = round2(r.spent + take);
    pool = round2(pool - take);
  }
  // Spend beyond every plan is most likely discretionary: it overspends the
  // first spending item, when there is one.
  if (pool > 0 && spending.length) {
    spending[0].spent = round2(spending[0].spent + pool);
    pool = 0;
  }

  for (const r of rows.values()) {
    r.spent = Math.max(0, r.spent);
    r.remaining = r.settledByLink ? 0 : round2(Math.max(0, r.planThisMonth - r.spent));
    r.overspent = round2(Math.max(0, r.spent - r.planThisMonth));
  }

  // ── 2. The saved split ───────────────────────────────────────────────────
  let left = round2(Math.max(0, Number(balance) || 0));
  const give = (r, want) => {
    const amt = round2(Math.max(0, Math.min(want, left)));
    r.allocated = round2(r.allocated + amt);
    left = round2(left - amt);
  };
  for (const r of [...bills, ...spending]) give(r, r.remaining);
  // One order for the rest of the split and for display: bills by their next
  // unpaid due date, then spending items the same way.
  const nextDate = r => (r.remaining > 0 ? r.dueThisMonth : (r.aheadDate || '9999-12-31'));
  const byNext = (a, b) => {
    const da = nextDate(a), db = nextDate(b);
    return da < db ? -1 : da > db ? 1 : 0;
  };
  const order = [...bills.slice().sort(byNext), ...spending.slice().sort(byNext)];

  let reserve = 0;
  for (const item of items) {
    const buf = Number(item.extra_buffer);
    if (Number.isFinite(buf) && buf > 0) reserve += buf;
  }
  reserve = round2(reserve);
  const reserveAllocated = round2(Math.min(reserve, left));
  left = round2(left - reserveAllocated);

  for (const r of order) {
    if (r.style !== 'bill') continue;
    const target = r.remaining > 0 ? r.remaining : r.aheadAmount;
    give(r, round2(target - r.allocated));
  }

  // ── 3. Status, from the projection ───────────────────────────────────────
  // `reserve` is the floor: the summed extra_buffer, as `envelopeFloor`.
  const series = Array.isArray(daily) ? daily : [];
  const balanceOn = (date) => {
    let found = null;
    for (const point of series) {
      if (point.date > date) break;
      found = point;
    }
    if (!found && series.length && date < series[0].date) found = series[0];
    return found;
  };
  const monthEnd = ymd(new Date(clock.getFullYear(), clock.getMonth() + 1, 0));
  let monthLow = null;
  for (const point of series) {
    if (point.date > monthEnd) break;
    if (!monthLow || point.balance < monthLow.balance) monthLow = point;
  }

  let shortfall = 0;
  /** @type {ItemFunding[]} */
  const out = order.map(r => {
    const nextDue = r.remaining > 0
      ? { date: r.dueThisMonth, amount: r.remaining }
      : (r.aheadDate ? { date: r.aheadDate, amount: r.aheadAmount } : null);
    let shortBy = 0;
    let shortDate = null;
    if (r.style === 'bill' && nextDue) {
      const point = balanceOn(nextDue.date);
      if (point && point.balance < reserve - CENT_EPSILON) {
        shortBy = round2(reserve - point.balance);
        shortDate = nextDue.date;
      }
    } else if (r.style === 'spending' && (r.remaining > 0 || r.overspent >= CENT_EPSILON) && monthLow
      && monthLow.balance < reserve - CENT_EPSILON) {
      // Spent past its plan counts too: the overspend is what drew the
      // envelope down, and without this it would read only "over".
      shortBy = round2(reserve - monthLow.balance);
      shortDate = monthLow.date;
    }
    if (shortBy > shortfall) shortfall = shortBy;
    /** @type {FundingStatus} */
    let status;
    // Short before over: an overspent item whose envelope still covers it is
    // information, not a problem; one that leaves the envelope short is both,
    // and short is the part that needs acting on.
    if (shortBy >= CENT_EPSILON) status = 'short';
    else if (r.style === 'spending' && r.overspent >= CENT_EPSILON) status = 'over';
    else if (r.style === 'bill' && (r.settledByLink || r.settledByTombstone
      || (r.planThisMonth > 0 && r.remaining < CENT_EPSILON))) status = 'paid';
    // The whole next payment is already in the envelope: no fill needed for it.
    else if (r.style === 'bill' && nextDue && r.allocated >= nextDue.amount - CENT_EPSILON) status = 'funded';
    else status = 'on_track';
    const base = r.style === 'bill' ? (nextDue ? nextDue.amount : 0) : r.remaining;
    return {
      itemId: r.item.id,
      name: r.item.description || r.item.id,
      style: r.style,
      planThisMonth: r.planThisMonth,
      spent: round2(r.spent),
      remaining: r.remaining,
      overspent: r.overspent,
      allocated: r.allocated,
      pct: base >= CENT_EPSILON ? Math.min(1, r.allocated / base) : null,
      status,
      shortBy,
      shortDate,
      nextDue,
    };
  });

  return {
    items: out,
    reserve,
    reserveAllocated,
    unassigned: left,
    shortfall: round2(shortfall),
    unlinkedSpent: round2(pool + foreignLinked),
  };
}

/**
 * `computeItemFunding` for every envelope with at least one funded item, for
 * the envelope list. `balances` is the as-of-today balance map;
 * `dailyByEnvelope` holds each envelope's projected series (the `daily` of
 * `computeSpareByEnvelope`), without which no item reads short.
 *
 * @param {object} input
 * @param {any[]} input.envelopes
 * @param {FundingItem[]} input.budgetItems
 * @param {any[]} input.transactions
 * @param {Map<string, number>} input.balances
 * @param {Date} input.today
 * @param {string} [input.country]
 * @param {string[]} [input.tombstones]
 * @param {Map<string, { date: string, balance: number }[]>} [input.dailyByEnvelope]
 * @returns {Map<string, EnvelopeFunding>}
 */
export function computeItemFundingByEnvelope({
  envelopes, budgetItems, transactions, balances, today, country = 'FI', tombstones = [],
  dailyByEnvelope = new Map(),
}) {
  const clock = requireClock(today, 'computeItemFundingByEnvelope');
  // Filter once, not per envelope.
  const todayStr = ymd(clock);
  // This month, plus the link window before it (early payments of this
  // month's bills, see computeItemFunding).
  const fromStr = ymd(new Date(clock.getFullYear(), clock.getMonth(), 1 - LINK_DAY_WINDOW));
  const monthTxs = (transactions || []).filter(tx => {
    const d = tx && typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    return d >= fromStr && d <= todayStr;
  });
  /** @type {Map<string, EnvelopeFunding>} */
  const out = new Map();
  for (const env of envelopes || []) {
    if (!env || env.archived) continue;
    if (envelopeFundingItems(budgetItems, env.id).length === 0) continue;
    const res = computeItemFunding({
      envelopeId: env.id, budgetItems, transactions: monthTxs,
      balance: balances.get(env.id) ?? 0, today: clock, country, tombstones,
      daily: dailyByEnvelope.get(env.id) || null,
    });
    if (res.items.length) out.set(env.id, res);
  }
  return out;
}
