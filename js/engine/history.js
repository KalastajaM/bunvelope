// js/engine/history.js — historical balance series and Age-of-Money math.
//
// `computeEnvelopeBalanceHistory` produces a single end-of-month total
// series for the savings-trend chart. The Age-of-Money family
// (`computeAgeOfMoney`, `computeAgeOfMoneyDetailed`,
// `computeAgeOfMoneyHistory`, `attributeAgeOfMoneyDrop`,
// `computeMoneyCushion`) walks the transaction history as a FIFO queue
// to estimate how long money has typically been sitting before being
// spent.
//
// Pure functions. No DOM, no I/O — and no clock. Every function here takes
// its reference date as a REQUIRED parameter rather than defaulting to
// `new Date()`.
//
// A default clock is untestable by omission: a caller that forgets `refDate`
// silently gets wall time, the result changes with the machine's timezone and
// the moment it ran, and nothing says so. It is also how a date test passes in
// one zone and fails in another — see `npm run test:tz`. The wall-clock read
// belongs at the impure edge (a page render, a scheduled job), which is where
// it now lives.

import { round2, wholeDaysBetween } from '../utils.js';
import { CENT_EPSILON, requireClock } from './_constants.js';
import { txAbsAmount, isPostedTx, txNetAccountDelta } from './tx-amounts.js';
import { computeAccountBalances, computeEnvelopeBalances, isSpendingAccount } from './balances.js';

// ─── Historical envelope balance series ──────────────────────────────────────

/**
 * Compute end-of-month envelope balances for the last `months` months
 * (oldest first). Returns:
 *   { months: ['2026-01', ...], totals: [{ label, value }, ...] }
 *
 * `totals` is the sum of all envelope balances at end-of-month — a single
 * line series ready for the existing chart helpers. Use for the "envelope
 * savings trend" surface.
 */
/**
 * @param {any[]} transactions
 * @param {number} months
 * @param {Date} refDate  the clock, supplied by the caller — see the note at
 *   the top of this file
 * @param {{ excludeIds?: Set<string> }} [opts]  envelopes left out of the total (page filter)
 */
export function computeEnvelopeBalanceHistory(transactions, months, refDate, opts = {}) {
  requireClock(refDate, 'computeEnvelopeBalanceHistory');
  const monthsLabels = [];
  const totals = [];
  for (let i = months - 1; i >= 0; i--) {
    const eom = new Date(refDate.getFullYear(), refDate.getMonth() - i + 1, 0);
    // Compare ISO date strings lexicographically (the filterTxs convention):
    // `new Date('YYYY-MM-DD')` parses as UTC midnight, which shifts
    // first-of-month rows into the previous month in UTC-negative zones.
    const eomStr = `${eom.getFullYear()}-${String(eom.getMonth() + 1).padStart(2, '0')}-${String(eom.getDate()).padStart(2, '0')}`;
    const upTo = (transactions || []).filter(tx => {
      if (!tx.date) return true;
      return String(tx.date).slice(0, 10) <= eomStr;
    });
    const balances = computeEnvelopeBalances(upTo);
    let sum = 0;
    for (const [id, v] of balances) if (!opts.excludeIds?.has(id)) sum += v;
    const label = `${eom.getFullYear()}-${String(eom.getMonth() + 1).padStart(2, '0')}`;
    monthsLabels.push(label);
    totals.push({ label, value: round2(sum) });
  }
  return { months: monthsLabels, totals };
}

/**
 * Month-end balances per envelope for the last `months` months (oldest
 * first), for the envelopes in `ids` — the per-envelope sibling of
 * `computeEnvelopeBalanceHistory`, with the same month-end cut-off and the
 * same transactions (so the caller's lens applies). An id with no rows reads
 * 0 every month.
 * @param {any[]} transactions
 * @param {number} months
 * @param {Date} refDate  the clock, supplied by the caller
 * @param {string[]} ids
 * @returns {{ months: string[], byId: Map<string, { label: string, value: number }[]> }}
 */
export function computeEnvelopeBalanceHistoryByEnvelope(transactions, months, refDate, ids) {
  requireClock(refDate, 'computeEnvelopeBalanceHistoryByEnvelope');
  /** @type {string[]} */
  const monthsLabels = [];
  /** @type {Map<string, { label: string, value: number }[]>} */
  const byId = new Map(ids.map(id => [id, []]));
  for (let i = months - 1; i >= 0; i--) {
    const eom = new Date(refDate.getFullYear(), refDate.getMonth() - i + 1, 0);
    const eomStr = `${eom.getFullYear()}-${String(eom.getMonth() + 1).padStart(2, '0')}-${String(eom.getDate()).padStart(2, '0')}`;
    const upTo = (transactions || []).filter(tx => !tx.date || String(tx.date).slice(0, 10) <= eomStr);
    const balances = computeEnvelopeBalances(upTo);
    const label = eomStr.slice(0, 7);
    monthsLabels.push(label);
    for (const id of ids) /** @type {any[]} */ (byId.get(id)).push({ label, value: round2(balances.get(id) ?? 0) });
  }
  return { months: monthsLabels, byId };
}

// ─── Age of Money ────────────────────────────────────────────────────────────

/**
 * Compute the average age (in whole days) of money used to fund the last
 * `windowDays` days of expenses, by replaying the transaction history as a
 * FIFO queue.
 *
 *   1. Walk posted income tx in date order → push onto a queue.
 *   2. Walk posted expense tx in date order → dequeue from the oldest end,
 *      recording (txDate − depositDate) for each euro pulled when the expense
 *      falls inside the (refDate − windowDays … refDate) window.
 *   3. Return the amount-weighted average age, rounded to whole days.
 *
 * Returns `null` when there's no qualifying spend in the window or when
 * spending exceeded received income (queue empty mid-spend) — the metric is
 * only meaningful once income has actually preceded spending.
 *
 * Adjustments are ignored, and so are transfers unless the caller marks the
 * ones that cross the spending pool's edge (`aomPoolTransactions`): money
 * moved out of the pool (salary to savings, a loan's principal) then consumes
 * the oldest money as an expense would, without being averaged as spending,
 * and money moved in joins the queue as income does. Unmarked, a transfer
 * shuffles money inside the system rather than adding or removing it.
 *
 * One-off inflows (`AOM_ONE_OFF_FACTOR`, `aomOneOffIncomes`) are left out of
 * the queue: a house sale would otherwise fund the "age" of every euro spent
 * for years after the money itself was moved on.
 */
/**
 * @param {any[]} transactions
 * @param {Date} refDate
 * @param {number} [windowDays]
 */
export function computeAgeOfMoney(transactions, refDate, windowDays = 30) {
  requireClock(refDate, 'computeAgeOfMoney');
  const r = _runAgeOfMoneyFifo(transactions, refDate, windowDays);
  return r.aom;
}

/**
 * Detailed variant: same FIFO walk, but also returns per-expense weights and
 * the income deposits inside the window. Used by the trend / anomaly UI.
 *
 * Shape: { aom, perExpense, incomes, recentSpend, recentAgeWeight, starvedInWindow }
 *   perExpense: [{ txId, date, amount, ageDays, ageWeight }]
 *     - `amount`     = euros from this expense that landed inside the window
 *                      (could be < tx.amount if FIFO ran out mid-tx)
 *     - `ageDays`    = amount-weighted average age of those euros (rounded)
 *     - `ageWeight`  = sum of (take * ageDays) — contribution to numerator
 *   incomes: [{ date, amount }] — posted incomes whose date is inside the window
 */
/**
 * @param {any[]} transactions
 * @param {Date} refDate
 * @param {number} [windowDays]
 */
export function computeAgeOfMoneyDetailed(transactions, refDate, windowDays = 30) {
  requireClock(refDate, 'computeAgeOfMoneyDetailed');
  return _runAgeOfMoneyFifo(transactions, refDate, windowDays);
}

/**
 * Returns AoM at the end of each of the last `months` calendar months,
 * oldest first. Uses the same `windowDays` (default 30) as the headline
 * metric, so each sample's AoM means the same thing as the dashboard number
 * would have at that moment. The last sample, the reference date's own
 * month, is taken at the reference date itself (its end of day), so it
 * equals the headline rather than reading a month that has not happened.
 *
 *   [{ monthKey: 'YYYY-MM', refDate: Date, aom: number|null }]
 *
 * One FIFO walk, not one per month. Which income an expense draws from does
 * not depend on the reference date (the queue is consumed in date order
 * whatever window is later read), so `_aomSpendLedger` records each
 * expense's draws once and each month-end only sums the ones in its window.
 * The sums run over the same draws in the same order as `computeAgeOfMoney`,
 * so every sample is bit-identical to calling it at that month-end
 * (pinned by a property test).
 */
/**
 * @param {any[]} transactions
 * @param {{ refDate: Date, months?: number, windowDays?: number }} opts
 */
export function computeAgeOfMoneyHistory(transactions, opts) {
  const refDate   = requireClock(opts?.refDate, 'computeAgeOfMoneyHistory');
  const months    = opts.months    || 12;
  const windowDays = opts.windowDays || 30;
  const spends = _aomSpendLedger(transactions);
  const out = [];
  const baseY = refDate.getFullYear();
  const baseM = refDate.getMonth();
  // Month-ends ascend, so both window edges only move forward: `lo` and `hi`
  // bracket the spends inside each window without rescanning from the start.
  let lo = 0;
  let hi = 0;
  for (let i = months - 1; i >= 0; i--) {
    const eom = new Date(baseY, baseM - i + 1, 0);
    eom.setHours(23, 59, 59, 999);
    // The reference date's own month is sampled AT the reference date, not
    // at its month end: the days after it have no posted rows yet, so a
    // month-end sample read a few days of spending and counted the pay days
    // still to come as an income gap.
    if (i === 0 && refDate < eom) eom.setDate(refDate.getDate());
    const monthKey = `${eom.getFullYear()}-${String(eom.getMonth() + 1).padStart(2, '0')}`;
    const win = trailingWindow(eom, windowDays);
    while (lo < spends.length && !(spends[lo].date > win.start)) lo++;
    if (hi < lo) hi = lo;
    while (hi < spends.length && spends[hi].date <= win.end) hi++;
    out.push({ monthKey, refDate: eom, aom: _aomFromSpends(spends, lo, hi) });
  }
  return out;
}

/** AoM over spends[lo, hi): the same sums, in the same order, as the FIFO walk. */
function _aomFromSpends(spends, lo, hi) {
  let recentSpend = 0;
  let recentAgeWeight = 0;
  for (let k = lo; k < hi; k++) {
    const s = spends[k];
    if (s.starved) return null;
    for (let j = 0; j < s.takes.length; j++) {
      recentSpend += s.takes[j];
      recentAgeWeight += s.takes[j] * s.ages[j];
    }
  }
  return recentSpend >= CENT_EPSILON ? Math.round(recentAgeWeight / recentSpend) : null;
}

// Thresholds: tuned for a 30-day AoM. Configurable later if needed.
export const AOM_HEALTH_GREEN = 30;   // >= 30d  -> healthy buffer
export const AOM_HEALTH_YELLOW = 14;  // 14..29d -> watching
                                      // < 14d   -> red

// "Healthy" also needs the runway to agree (owner decision 2026-10-05): old
// money says little when the cash would last only weeks. Below this many days
// of runway (three months of the recent spending) green becomes yellow.
export const AOM_HEALTHY_RUNWAY_DAYS = 90;

// One-off inflows (owner decision 2026-10-05). A house sale or a vested-share
// payout parked on the main account sits at the head of the FIFO queue for
// years — the money moved on by transfers, which the walk then ignored (it
// reads them only when `aomPoolTransactions` marks them, since 2026-10-06) —
// and Age of Money read in the hundreds of days while the cash lasted weeks.
// The reserve stays: a windfall still should not age the regular money. So an
// income row larger than AOM_ONE_OFF_FACTOR times the median monthly income
// of the AOM_ONE_OFF_LOOKBACK_MONTHS calendar months before it (counting the
// months with income, at least AOM_ONE_OFF_MIN_MONTHS of them) never enters
// the queue. A yearly bonus (one to two months' pay) stays in; with too
// little history nothing is left out.
export const AOM_ONE_OFF_FACTOR = 3;
export const AOM_ONE_OFF_LOOKBACK_MONTHS = 12;
export const AOM_ONE_OFF_MIN_MONTHS = 3;

/** @typedef {{ txId: any, date: string, amount: number }} AomOneOff */
/**
 * One row of the FIFO walk: `income` joins the queue, `expense` is spent from
 * it (and averaged), `outflow` leaves the pool (consumes, not averaged).
 * @typedef {{ id: any, type: 'income' | 'expense' | 'outflow', iso: string, date: Date, amt: number, oneOff?: boolean }} AomRow
 */

// The transfer types that can carry money across the spending pool's edge.
const AOM_TRANSFER_TYPES = new Set(['account_transfer', 'debt_payment', 'investment_transfer']);
const aomPoolCache = new WeakMap(); // transactions -> WeakMap<poolIds, rows>

/**
 * The rows for Age of Money over a pool of accounts (the spending accounts),
 * with each transfer that crosses the pool's edge marked for the FIFO walk:
 * `aom_flow: 'out'` when it took money out of the pool (to savings, an
 * investment, a loan's principal), `'in'` when it brought money in, and
 * `aom_amount` the magnitude that crossed. A transfer between two pool
 * accounts, or between two accounts outside it, is left as it is, and so is
 * every other row: the walk ignores an unmarked transfer.
 *
 * This is the usual (YNAB-style) definition: money leaving the budget by
 * transfer consumes the oldest money, as spending does, and money arriving by
 * transfer is new money. Without it a salary moved on to savings stayed at
 * the head of the queue, and every euro spent later looked months old (owner
 * decision 2026-10-06). The outflow is not averaged: Age of Money is the age
 * of the money SPENT.
 *
 * A marked row is a copy carrying two extra fields; the balance walks ignore
 * them. Memoised on the identity of both arguments, so callers should pass a
 * memoised `poolIds` (js/core/operational.js does).
 *
 * @param {any[]} transactions
 * @param {Set<string>} poolIds  ids of the pool's accounts
 * @returns {any[]}
 */
export function aomPoolTransactions(transactions, poolIds) {
  if (!Array.isArray(transactions) || !poolIds) return transactions || [];
  let byPool = aomPoolCache.get(transactions);
  if (!byPool) { byPool = new WeakMap(); aomPoolCache.set(transactions, byPool); }
  const hit = byPool.get(poolIds);
  if (hit) return hit;
  const out = transactions.map(tx => {
    if (!tx || !AOM_TRANSFER_TYPES.has(tx.type)) return tx;
    const net = txNetAccountDelta(tx, poolIds);
    if (Math.abs(net) < CENT_EPSILON) return tx;
    return { ...tx, aom_flow: net < 0 ? 'out' : 'in', aom_amount: Math.abs(net) };
  });
  byPool.set(poolIds, out);
  return out;
}

const AOM_DROP_THRESHOLD_DAYS = 7;
const AOM_BIG_EXPENSE_SHARE = 0.4;
const AOM_INCOME_GAP_DAYS = 14;

/**
 * Given two `computeAgeOfMoneyDetailed` results (consecutive samples),
 * explain the drop in AoM if there is one worth flagging. Returns `null`
 * when no meaningful drop occurred (`prev.aom - curr.aom < AOM_DROP_THRESHOLD_DAYS`)
 * or when either side lacks data.
 *
 * Heuristic, in order:
 *   1. `big_expense` — a single expense in `curr` accounts for >=40% of the
 *      window's total ageWeight. The expense and its weight are returned.
 *   2. `income_gap`  — longest gap between consecutive incomes in `curr`'s
 *      window (including the gap from window-start and to refDate) is >=14d.
 *   3. `broad_shift` — none of the above; the drop is diffuse.
 */
export function attributeAgeOfMoneyDrop(prev, curr) {
  if (!prev || !curr) return null;
  if (prev.aom == null || curr.aom == null) return null;
  const drop = prev.aom - curr.aom;
  if (drop < AOM_DROP_THRESHOLD_DAYS) return null;

  // 1. Big expense?
  const totalWeight = (curr.perExpense || []).reduce((s, e) => s + e.ageWeight, 0);
  if (totalWeight > 0) {
    let top = null;
    for (const e of curr.perExpense) {
      if (!top || e.ageWeight > top.ageWeight) top = e;
    }
    if (top && top.ageWeight / totalWeight >= AOM_BIG_EXPENSE_SHARE) {
      return {
        kind: 'big_expense',
        drop,
        txId: top.txId,
        amount: top.amount,
        ageDays: top.ageDays,
        share: top.ageWeight / totalWeight,
      };
    }
  }

  // 2. Income gap?
  const windowStart = new Date(curr.refDate);
  windowStart.setHours(0, 0, 0, 0);
  windowStart.setDate(windowStart.getDate() - (curr.windowDays || 30));
  const ref = new Date(curr.refDate);
  ref.setHours(0, 0, 0, 0);

  const sortedIncomes = (curr.incomes || []).slice().sort((a, b) => a.date - b.date);
  const points = [windowStart, ...sortedIncomes.map(x => x.date), ref];
  let maxGap = 0, gapStart = null, gapEnd = null;
  for (let i = 1; i < points.length; i++) {
    const days = Math.max(0, wholeDaysBetween(points[i - 1], points[i]));
    if (days > maxGap) { maxGap = days; gapStart = points[i - 1]; gapEnd = points[i]; }
  }
  if (maxGap >= AOM_INCOME_GAP_DAYS) {
    return { kind: 'income_gap', drop, gapStart, gapEnd, gapDays: maxGap };
  }

  // 3. Diffuse.
  return { kind: 'broad_shift', drop };
}

/**
 * Snapshot of "how much cushion do I have right now":
 *
 *   aom              — headline AoM
 *   recentSpendPerDay — average of posted expenses in the last `windowDays` ÷ windowDays
 *   runwayDays       — how many days the current liquid balance lasts at that rate
 *   liquidBalance    — posted balance of the non-archived spending accounts
 *   health           — 'green'|'yellow'|'red'|null based on AoM thresholds,
 *                      green only with AOM_HEALTHY_RUNWAY_DAYS of runway
 *                      (or no recent spending to measure it by)
 *   runwayLimited    — true when the runway turned green into yellow
 *
 * "Liquid" = `isSpendingAccount(account)` and `!account.archived`: cash, the
 * current accounts and the credit cards, whose debt is money already spent.
 * Never pension (owner decision 2026-09-23, ux-review U2). It used to be every
 * non-credit-card account, which counted pension for any caller passing the
 * whole account list and ignored card debt.
 * Adjustments and transfers are excluded from the spend-rate by design (same
 * spirit as `computeAgeOfMoney`).
 */
/**
 * @param {any[]} accounts
 * @param {any[]} transactions
 * @param {Date} refDate
 * @param {number} [windowDays]
 */
export function computeMoneyCushion(accounts, transactions, refDate, windowDays = 30) {
  requireClock(refDate, 'computeMoneyCushion');
  const aom = computeAgeOfMoney(transactions, refDate, windowDays);

  const win = trailingWindow(refDate, windowDays);
  let recentSpendTotal = 0;
  for (const tx of (transactions || [])) {
    if (tx.type !== 'expense') continue;
    if (tx.is_forecast) continue;
    if (tx.status && tx.status !== 'posted') continue;
    if (!tx.date || !/^\d{4}-\d{2}-\d{2}/.test(tx.date)) continue;
    const d = new Date(tx.date.slice(0, 10) + 'T00:00:00');
    if (!inTrailingWindow(d, win)) continue;
    recentSpendTotal += txAbsAmount(tx);
  }
  const recentSpendPerDay = windowDays > 0 ? recentSpendTotal / windowDays : 0;

  // Liquid balance: posted-only across the non-archived spending accounts.
  const liquidAccounts = (accounts || []).filter(a => isSpendingAccount(a) && !a.archived);
  const balances = computeAccountBalances(accounts || [], transactions || [], { onlyPosted: true });
  let liquidBalance = 0;
  for (const a of liquidAccounts) liquidBalance += balances.get(a.id) ?? 0;

  const runwayDays = recentSpendPerDay > 0
    ? Math.max(0, Math.floor(liquidBalance / recentSpendPerDay))
    : null;

  /** @type {'green' | 'yellow' | 'red' | null} */
  let health = null;
  if (aom != null) {
    if (aom >= AOM_HEALTH_GREEN) health = 'green';
    else if (aom >= AOM_HEALTH_YELLOW) health = 'yellow';
    else health = 'red';
  }
  // Healthy only when the runway agrees (AOM_HEALTHY_RUNWAY_DAYS).
  const runwayLimited = health === 'green' && runwayDays !== null && runwayDays < AOM_HEALTHY_RUNWAY_DAYS;
  if (runwayLimited) health = 'yellow';

  return { aom, recentSpendPerDay, liquidBalance, runwayDays, health, runwayLimited };
}

// Internal: the refDate-independent half of the FIFO walk — filter, parse
// and sort. Memoized by transactions-array identity because
// `computeAgeOfMoneyHistory` calls the walk once per month (12×, plus one
// more from `computeMoneyCushion`), and re-sorting the entire posted
// history 13 times per dashboard render was the dominant render cost.
//
// Identity keying mirrors js/engine/balance-cache.js: transaction writes
// always reassign `state.transactions` rather than mutating in place, so a
// changed array is a changed identity. Entries hold only scalars copied out
// of each row, so a cached entry can never observe a later mutation of the
// row it came from — and the walk below never mutates them.
const aomPrepCache = new WeakMap();

/**
 * The trailing-window membership test, in one place.
 *
 * §2.6 — Age of Money and the money cushion measured DIFFERENT windows in one
 * call, and did not even share a start date. AoM set `ref` to 00:00:00 and
 * took `txDate >= ref − windowDays`, admitting days `[ref−30 … ref]` — 31 of
 * them. The cushion set `ref` to 23:59:59.999, so a midnight transaction date
 * had to be strictly later than `ref − 30` at 23:59, giving 30 days starting at
 * `ref−29`. The cushion then divided by `windowDays`, which is right for 30
 * days and wrong for 31. Around a month boundary — exactly when a large bill
 * or a paycheck sits at the edge — the dashboard's two figures could move in
 * opposite directions for no reason the user could see.
 *
 * The convention kept is the cushion's half-open `(ref − windowDays, ref]`,
 * because that is the one whose day count matches the divisor.
 *
 * @param {Date} txDate   transaction date, normalised to midnight
 * @param {{start: Date, end: Date}} win  from `trailingWindow`
 */
export function inTrailingWindow(txDate, win) {
  return txDate > win.start && txDate <= win.end;
}

/**
 * Build the half-open trailing window `(ref − windowDays, ref]`.
 * `end` is the last instant of the reference day so a midnight-stamped
 * transaction dated `ref` is inside it; `start` carries the same time so the
 * span is exactly `windowDays` whole days.
 */
export function trailingWindow(refDate, windowDays) {
  const end = new Date(refDate);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - windowDays);
  return { start, end };
}

function _prepareAomTxs(transactions) {
  return _classifyAomTxs(transactions).prepared;
}

/**
 * The FIFO walk's rows (posted income and expense, and the marked pool
 * transfers as `income` and `outflow`; dated, positive, in date order), the
 * one-off inflows among them marked `oneOff`, and those one-offs.
 * Memoised on the array's identity, like the prep it replaces (see
 * `aomPrepCache`).
 *
 * @param {any[]} transactions
 * @returns {{ prepared: AomRow[], oneOffs: AomOneOff[] }}
 */
function _classifyAomTxs(transactions) {
  if (!transactions || typeof transactions !== 'object') return { prepared: [], oneOffs: [] };
  const cached = aomPrepCache.get(transactions);
  if (cached) return cached;

  const all = [];
  for (const t of transactions) {
    if (!t) continue;
    // A transfer marked by aomPoolTransactions is an inflow (read as income)
    // or an outflow; any other transfer moves nothing in or out of the walk.
    const flow = t.aom_flow === 'in' || t.aom_flow === 'out' ? t.aom_flow : null;
    if (!flow && t.type !== 'income' && t.type !== 'expense') continue;
    if (!isPostedTx(t)) continue;
    if (!t.date || !/^\d{4}-\d{2}-\d{2}/.test(t.date)) continue;
    const date = new Date(t.date.slice(0, 10) + 'T00:00:00');
    if (isNaN(date.getTime())) continue;
    const type = flow === 'in' ? 'income' : flow === 'out' ? 'outflow' : t.type;
    const amt = flow ? (Number(t.aom_amount) || 0) : txAbsAmount(t);
    // Zero/negative magnitudes contributed nothing to the FIFO queue and
    // were skipped inside the loop; drop them once here instead.
    if (amt <= 0) continue;
    all.push({ id: t.id, type, iso: String(t.date), date, amt });
  }
  all.sort((a, b) => a.iso.localeCompare(b.iso));

  const isOneOff = _aomOneOffTest(all);
  /** @type {AomOneOff[]} */
  const oneOffs = [];
  const prepared = all.map(row => {
    if (row.type !== 'income' || !isOneOff(row)) return row;
    oneOffs.push({ txId: row.id, date: row.iso.slice(0, 10), amount: round2(row.amt) });
    return { ...row, oneOff: true };
  });

  const out = { prepared, oneOffs };
  aomPrepCache.set(transactions, out);
  return out;
}

/** `YYYY-MM` → a month number that steps by one per calendar month. */
const _monthIndex = (/** @type {string} */ iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/**
 * Whether an income row is a one-off (see `AOM_ONE_OFF_FACTOR`): more than
 * the factor times the median monthly income of the twelve calendar months
 * before its own, over the months that had income, when at least
 * `AOM_ONE_OFF_MIN_MONTHS` of them did. The medians read every income row,
 * one-offs included (a median shrugs them off), so the test depends on the
 * history alone and never on a reference date.
 *
 * @param {Array<{ type: string, iso: string, amt: number }>} rows  date order
 * @returns {(row: { type: string, iso: string, amt: number }) => boolean}
 */
function _aomOneOffTest(rows) {
  /** @type {Map<number, number>} month index → income that month */
  const monthly = new Map();
  for (const r of rows) {
    if (r.type !== 'income') continue;
    const m = _monthIndex(r.iso);
    monthly.set(m, (monthly.get(m) ?? 0) + r.amt);
  }
  /** @type {Map<number, number | null>} */
  const medians = new Map();
  const medianBefore = (/** @type {number} */ m) => {
    if (medians.has(m)) return /** @type {number | null} */ (medians.get(m));
    const totals = [];
    for (let k = m - AOM_ONE_OFF_LOOKBACK_MONTHS; k < m; k++) {
      const v = monthly.get(k);
      if (v !== undefined && v > 0) totals.push(v);
    }
    let med = null;
    if (totals.length >= AOM_ONE_OFF_MIN_MONTHS) {
      totals.sort((a, b) => a - b);
      const mid = totals.length >> 1;
      med = totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
    }
    medians.set(m, med);
    return med;
  };
  return (row) => {
    const med = medianBefore(_monthIndex(row.iso));
    return med !== null && row.amt > AOM_ONE_OFF_FACTOR * med;
  };
}

/**
 * The income rows Age of Money leaves out as one-offs (`AOM_ONE_OFF_FACTOR`),
 * in date order: the sale of a house, a severance, shares vested and sold.
 * Pass the same rows the Age of Money functions are given.
 *
 * @param {any[]} transactions
 * @returns {AomOneOff[]}
 */
export function aomOneOffIncomes(transactions) {
  return _classifyAomTxs(transactions).oneOffs;
}

const aomSpendCache = new WeakMap();

/**
 * Every expense's draws from the income queue, in date order: one FIFO walk,
 * independent of any reference date. `takes[j]` euros aged `ages[j]` days;
 * `starved` when income ran out before the expense was covered.
 */
function _aomSpendLedger(transactions) {
  if (!transactions || typeof transactions !== 'object') return [];
  const cached = aomSpendCache.get(transactions);
  if (cached) return cached;
  const queue = [];
  const reserve = [];
  const spends = [];
  for (const tx of _prepareAomTxs(transactions)) {
    if (tx.type === 'income') {
      (tx.oneOff ? reserve : queue).push({ date: tx.date, remaining: tx.amt });
      continue;
    }
    if (tx.type === 'outflow') { _aomConsume(queue, reserve, tx.amt); continue; }
    let need = tx.amt;
    const takes = [];
    const ages = [];
    while (need > CENT_EPSILON && (queue.length || reserve.length)) {
      const q = queue.length ? queue : reserve;
      const head = q[0];
      const take = Math.min(need, head.remaining);
      head.remaining -= take;
      need -= take;
      if (head.remaining < CENT_EPSILON) q.shift();
      takes.push(take);
      ages.push(Math.max(0, wholeDaysBetween(head.date, tx.date)));
    }
    spends.push({ date: tx.date, takes, ages, starved: need > CENT_EPSILON });
  }
  aomSpendCache.set(transactions, spends);
  return spends;
}

/**
 * Take `amount` from the queue's oldest money, then from the reserve: money
 * that left the spending pool (an `outflow`). Nothing is recorded, since it
 * was not spent; running out is not starvation either, since the money was
 * moved, not short.
 *
 * @param {Array<{ date: Date, remaining: number }>} queue
 * @param {Array<{ date: Date, remaining: number }>} reserve
 * @param {number} amount
 */
function _aomConsume(queue, reserve, amount) {
  let need = amount;
  while (need > CENT_EPSILON && (queue.length || reserve.length)) {
    const q = queue.length ? queue : reserve;
    const head = q[0];
    const take = Math.min(need, head.remaining);
    head.remaining -= take;
    need -= take;
    if (head.remaining < CENT_EPSILON) q.shift();
  }
}

// Internal: shared FIFO walk used by both the lean and detailed AoM variants.
// Centralizing here so the input filters and FIFO semantics never drift.
function _runAgeOfMoneyFifo(transactions, refDate, windowDays) {
  const txs = _prepareAomTxs(transactions);

  const queue = [];
  const reserve = [];
  const perExpense = [];
  const incomes = [];
  let recentSpend = 0;
  let recentAgeWeight = 0;
  let starvedInWindow = false;

  // Shared with computeMoneyCushion — see inTrailingWindow. AoM used to set
  // `ref` to midnight and compare `>= ref − windowDays`, which admitted one
  // day more than the cushion counted and divided by.
  const win = trailingWindow(refDate, windowDays);
  const ref = win.end;

  for (const tx of txs) {
    // Filtering, date parsing and amount magnitude are done once in
    // _prepareAomTxs and shared across every refDate.
    const txDate = tx.date;
    const amt = tx.amt;

    if (tx.type === 'income') {
      if (tx.oneOff) { reserve.push({ date: txDate, remaining: amt }); continue; }
      queue.push({ date: txDate, remaining: amt });
      if (inTrailingWindow(txDate, win)) incomes.push({ date: txDate, amount: amt });
      continue;
    }
    if (tx.type === 'outflow') { _aomConsume(queue, reserve, amt); continue; }

    let need = amt;
    const inWindow = inTrailingWindow(txDate, win);
    let exTake = 0;
    let exWeight = 0;
    while (need > CENT_EPSILON && (queue.length || reserve.length)) {
      const q = queue.length ? queue : reserve;
      const head = q[0];
      const take = Math.min(need, head.remaining);
      head.remaining -= take;
      need -= take;
      if (head.remaining < CENT_EPSILON) q.shift();
      if (inWindow) {
        const ageDays = Math.max(0, wholeDaysBetween(head.date, txDate));
        recentSpend += take;
        recentAgeWeight += take * ageDays;
        exTake += take;
        exWeight += take * ageDays;
      }
    }
    if (need > CENT_EPSILON && inWindow) starvedInWindow = true;
    if (inWindow && exTake > 0) {
      perExpense.push({
        txId: tx.id,
        date: txDate,
        amount: round2(exTake),
        ageDays: Math.round(exWeight / exTake),
        ageWeight: exWeight,
      });
    }
  }

  let aom = null;
  if (!starvedInWindow && recentSpend >= CENT_EPSILON) {
    aom = Math.round(recentAgeWeight / recentSpend);
  }
  return { aom, perExpense, incomes, recentSpend, recentAgeWeight, starvedInWindow,
           refDate: ref, windowDays };
}
