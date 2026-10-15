// js/engine/reports.js — date-range aggregations for the reports page.
//
// All aggregators return arrays of plain objects shaped for the chart helpers.
// They share a date-range filter signature: (transactions, { from, to }, ...).
// `from` and `to` are inclusive 'YYYY-MM-DD' strings; either may be null.
//
// Pure functions. No DOM, no I/O.

import { round2 } from '../utils.js';
import { MONTH_NAMES, isIncomeLikeItem } from './_constants.js';
import { computeEnvelopeBalances, txConsumptionPairs, txConsumptionTotal, loanAccountIds } from './balances.js';
import { txAbsAmount, txAccountDelta, txDirection } from './tx-amounts.js';

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

// ── One definition of "spent" ─────────────────────────────────────────────
//
// §2.1 — "how much did I spend this month" was answered by four different
// pieces of code in v1, and they did not agree:
//
//   • the reports module filtered `tx.type === 'expense'`;
//   • the dashboard KPI filtered `expense && isPostedTx`;
//   • the dashboard donut and trend filtered `expense`, with no status test;
//   • the envelopes meter and monthly review used `txEnvelopeSpend`, a closed
//     set: expenses, debt payments, and the BUY leg of an investment transfer.
//
// Worse, this module's own aggregates did not sum to each other:
// `aggregateSpendingByEnvelope` required an envelope (it has to — the
// envelope is the grouping key) while the by-month and payee aggregates did
// not. So two charts on one page, over one range, produced different totals.
//
// `txSpendPairs` / `txSpendTotal` (balances.js) are that one rule. Every
// aggregate below is a sum of the same per-envelope figures, so all of them
// agree by construction rather than by coincidence.
//
// What that changed, measured on the owner's budget: 74 investment-buy rows
// carrying an envelope, across 21 distinct months, counted as spend where
// the reports counted none — and 3 expense rows charged to no envelope stop
// counting, where the by-month and payee reports previously included them.
//
// 2026-09-24 — the totals here now use `txConsumptionPairs`, the same rule
// minus investment transfers: the owner decided savings and investments are
// not spending (ux-review U5), so those 74 buys moved to the Saving series.

function envelopeDisplayLabel(env) {
  if (!env) return '(Unknown)';
  return `${env.category} · ${env.name}`;
}

/**
 * The payee a transaction is grouped under in the payee report and matched on
 * by the Reports payee filter: `tx.payee` trimmed, or '(no payee)'.
 * @param {any} tx
 * @returns {string}
 */
export function txPayeeLabel(tx) {
  return (tx && tx.payee && String(tx.payee).trim()) || '(no payee)';
}

/**
 * One transaction's Spending total, leaving out the excluded envelopes'
 * lines of a split (a split's other lines still count).
 * @param {any} tx
 * @param {Set<string> | undefined} excl
 * @param {Set<string> | null} [loans]  `loanAccountIds(accounts)`
 */
function consumptionTotal(tx, excl, loans = null) {
  if (!excl || !excl.size) return txConsumptionTotal(tx, loans);
  let sum = 0;
  for (const [envId, amt] of txConsumptionPairs(tx, loans)) if (!excl.has(envId)) sum += amt;
  return sum;
}

/**
 * Total spending per envelope across the range. Only `expense` type contributes.
 * Labels are "Category · Name". Expenses with no envelope_id are skipped.
 * @param {{ excludeEnvelopes?: Set<string>, accounts?: any[] }} [opts]  page filter: envelopes left out; `accounts` so principal paid into a loan is not Spending
 * @returns {Array<{label, value}>}
 */
export function aggregateSpendingByEnvelope(transactions, envelopes, range = {}, topN = 12, opts = {}) {
  const envelopeById = new Map();
  for (const env of envelopes || []) envelopeById.set(env.id, env);

  const sums = new Map(); // key → { label, value }
  const bump = (key, label, amt) => {
    const slot = sums.get(key) ?? { key, label, value: 0 };
    slot.value += amt;
    sums.set(key, slot);
  };
  const loans = loanAccountIds(opts.accounts);
  for (const tx of transactions) {
    if (!inRange(tx.date, range.from, range.to)) continue;
    for (const [envId, amt] of txConsumptionPairs(tx, loans)) {
      if (opts.excludeEnvelopes?.has(envId)) continue;
      bump(envId, envelopeDisplayLabel(envelopeById.get(envId)), amt);
    }
  }
  const rows = [...sums.values()]
    .map(r => ({ key: r.key, label: r.label, value: round2(r.value) }))
    .sort((a, b) => b.value - a.value);
  if (topN && rows.length > topN) {
    const head = rows.slice(0, topN);
    const rest = rows.slice(topN);
    const other = rest.reduce((s, r) => s + r.value, 0);
    // `key: null` rather than absent: every other row carries one, and the
    // chart component (js/ui/charts/) makes a row clickable only when its key
    // is non-null, so an "Other" row stays deliberately unclickable while the
    // row shape stays uniform for anything else reading the list.
    head.push({ key: null, label: `Other (${rest.length})`, value: round2(other) });
    return head;
  }
  return rows;
}

/**
 * Total spending per payee across the range. Only `expense` type contributes
 * (transfers / fills don't have a meaningful "payee"). Empty / missing payees
 * are bucketed as '(no payee)'.
 * @param {{ excludeEnvelopes?: Set<string>, accounts?: any[] }} [opts]  page filter: envelopes left out; `accounts` so principal paid into a loan is not Spending
 * @returns {Array<{label, value}>}
 */
export function aggregatePayeeSpending(transactions, range = {}, topN = 12, opts = {}) {
  const sums = new Map();
  const bump = (label, amt) => sums.set(label, (sums.get(label) || 0) + amt);
  const loans = loanAccountIds(opts.accounts);
  for (const tx of transactions) {
    if (!inRange(tx.date, range.from, range.to)) continue;
    const amt = consumptionTotal(tx, opts.excludeEnvelopes, loans);
    if (!amt) continue;
    const label = txPayeeLabel(tx);
    bump(label, amt);
  }
  const rows = [...sums.entries()]
    .map(([label, value]) => ({ key: label, label, value: round2(value) }))
    .sort((a, b) => b.value - a.value);
  if (topN && rows.length > topN) {
    const head = rows.slice(0, topN);
    const rest = rows.slice(topN);
    const other = rest.reduce((s, r) => s + r.value, 0);
    // `key: null` rather than absent: every other row carries one, and the
    // chart component (js/ui/charts/) makes a row clickable only when its key
    // is non-null, so an "Other" row stays deliberately unclickable while the
    // row shape stays uniform for anything else reading the list.
    head.push({ key: null, label: `Other (${rest.length})`, value: round2(other) });
    return head;
  }
  return rows;
}


/**
 * Whether an account belongs to the saving class: a `savings` account, or an
 * `investment` one (brokerage and pension wrappers alike — `pensionInsurance`
 * is a display flag on an investment account). Everything else — bank,
 * checking, cash, credit card, an unknown or missing account — is outside it.
 *
 * QA 2026-09-23 — this used to be `savings` alone, so moving cash into a
 * brokerage or pension account counted as zero saving.
 *
 * @param {{ type?: string } | null | undefined} account
 * @returns {boolean}
 */
function isSavingClassAccount(account) {
  // Loans count, owed and given: principal paid into a debt raises net worth
  // exactly as a deposit into savings does, money lent out is still the
  // household's, and drawing on either is the reverse.
  return account?.type === 'savings' || account?.type === 'investment'
    || account?.type === 'loan' || account?.type === 'loan_given';
}

/**
 * Whether a row moves money BETWEEN two of the budget's accounts, and so can
 * carry it across the saving boundary. Income, expenses, fills and
 * adjustments bring money in from (or send it out to) the world outside the
 * budget: interest paid into a savings account is growth, not saving, and a
 * bill paid from savings is spending. An investment_transfer qualifies only
 * on its buy and sell legs — a dividend is income-shaped (the paying
 * investment account does not move; see `txAccountDelta`), so it is growth
 * wherever it lands, and an `adjust` is a holdings correction moving no cash.
 *
 * @param {{ type?: string, direction?: string }} tx
 * @returns {boolean}
 */
function isAccountToAccountMove(tx) {
  if (tx.type === 'account_transfer' || tx.type === 'debt_payment') return true;
  if (tx.type === 'investment_transfer') {
    const dir = txDirection(tx);
    return dir === 'buy' || dir === 'sell';
  }
  return false;
}

/**
 * A transaction's effect on saving: the money it moves INTO the saving class
 * (see `isSavingClassAccount`) from outside it, negative when it moves money
 * back out. `null` when the row does not cross the boundary, so a caller can
 * tell "crossed, net 0" from "not a saving row".
 *
 * One rule for every account-to-account type, read off the classes of the two
 * sides; the sign and amount come from `txAccountDelta` on the saving side, so
 * the per-type sign rules (and the self-transfer zero) are not re-derived:
 *
 *   • one side saving, money arrived there   = +amount  (checking → savings,
 *     checking → investment, a buy paid from checking)
 *   • one side saving, money left it         = −amount  (savings → checking,
 *     a sell paid into checking, a debt payment funded from savings)
 *   • both sides saving                      = null     (savings ↔ investment,
 *     a buy paid from savings or an investment account's cash, a sell into
 *     savings — the money was already saved)
 *   • neither side saving                    = null     (checking → card)
 *
 * 2026-09-24 — a buy used to count +amount whatever paid for it, so cash moved
 * checking → savings (counted) and then spent on a buy from savings (counted
 * again) was saved twice, and a sell paid into checking never read as a
 * withdrawal. Owner-approved: only the boundary crossing counts.
 *
 * §2.2 — before that, the withdrawal arm was missing entirely, so the series
 * could never go down. 02-business-rules/04-forecast-and-history.md §7:
 * savings-to-checking is a withdrawal.
 *
 * @param {any} tx
 * @param {Map<string, { type?: string }>} accountsById
 * @returns {number | null}
 */
function savingEffect(tx, accountsById) {
  if (!tx || !isAccountToAccountMove(tx)) return null;
  const from = tx.from_account;
  const to = tx.to_account;
  const fromSaving = isSavingClassAccount(accountsById.get(from));
  const toSaving = isSavingClassAccount(accountsById.get(to));
  if (fromSaving === toSaving) return null;
  return txAccountDelta(tx, fromSaving ? from : to);
}

/**
 * Signed saving amount of one transaction; 0 when it does not cross the
 * saving boundary. See `savingEffect`.
 *
 * @param {any} tx
 * @param {Map<string, { type?: string }>} accountsById
 * @returns {number}
 */
function savingAmount(tx, accountsById) {
  return savingEffect(tx, accountsById) ?? 0;
}

/**
 * Which way a move between two accounts crosses the saving boundary, and
 * which bucket its saving-class side belongs to: a `loan` account is Debt
 * (principal repaid, or a loan drawn), every other saving-class account
 * (savings, investment, money lent out) is Saving. `null` when the move does
 * not cross. The Money flow page shows the two apart; the Charts page's
 * Saving series is their sum.
 *
 * @param {{ type?: string } | null | undefined} fromAccount
 * @param {{ type?: string } | null | undefined} toAccount
 * @returns {{ direction: 'in' | 'out', bucket: 'saving' | 'debt' } | null}
 */
export function savingBoundary(fromAccount, toAccount) {
  const fromSaving = isSavingClassAccount(fromAccount);
  const toSaving = isSavingClassAccount(toAccount);
  if (fromSaving === toSaving) return null;
  const side = toSaving ? toAccount : fromAccount;
  return { direction: toSaving ? 'in' : 'out', bucket: side?.type === 'loan' ? 'debt' : 'saving' };
}

/**
 * `savingEffect` with its bucket (see `savingBoundary`); `null` when the row
 * does not cross the saving boundary or nets to zero.
 *
 * @param {any} tx
 * @param {Map<string, { type?: string }>} accountsById
 * @returns {{ bucket: 'saving' | 'debt', amount: number } | null}
 */
export function txSavingFlow(tx, accountsById) {
  const amount = savingEffect(tx, accountsById);
  if (!amount) return null;
  const b = savingBoundary(accountsById.get(tx.from_account), accountsById.get(tx.to_account));
  return b && { bucket: b.bucket, amount };
}

/**
 * Income vs spending vs saving per month within the range. "Saving" is
 * money moved to savings/investment/pension accounts — see `savingAmount`.
 * @param {{ excludeEnvelopes?: Set<string> }} [opts]  page filter: envelopes left out (Spending only)
 * @returns {{ series: Array, months: Array<string> }}
 */
export function aggregateIncomeVsSpending(transactions, accounts, range = {}, opts = {}) {
  const accountsById = new Map();
  for (const a of (accounts || [])) accountsById.set(a.id, a);

  const loans = loanAccountIds(accounts);
  const monthly = new Map(); // 'YYYY-MM' → { income, spending, saving }
  for (const tx of transactions) {
    if (!inRange(tx.date, range.from, range.to)) continue;
    const m = tx.date.slice(0, 7);
    const slot = monthly.get(m) ?? { income: 0, spending: 0, saving: 0 };
    // Each series reads the amount through its own helper. This loop used to
    // open with `validateAmount(tx.amount) ?? continue`, which was the income
    // branch's guard doing duty for all three: a row whose top-level `amount`
    // was missing or malformed dropped out of the SPENDING series too, even
    // when its splits were perfectly readable.
    if (tx.type === 'income') slot.income += txAbsAmount(tx);
    else slot.saving += savingAmount(tx, accountsById);
    // Spending and saving are exclusive: an investment buy is saving, not
    // spending (owner decision 2026-09-23, see `txConsumptionPairs`), so a
    // euro moved into a fund no longer appears in both series.
    slot.spending += consumptionTotal(tx, opts.excludeEnvelopes, loans);
    monthly.set(m, slot);
  }
  const months = [...monthly.keys()].sort();
  const income   = months.map(m => ({ label: m, value: round2(monthly.get(m).income) }));
  const spending = months.map(m => ({ label: m, value: round2(monthly.get(m).spending) }));
  const saving   = months.map(m => ({ label: m, value: round2(monthly.get(m).saving) }));
  return {
    months,
    series: [
      { name: 'Income',   color: '#10b981', points: income },
      { name: 'Spending', color: '#ef4444', points: spending },
      { name: 'Saving',   color: '#3b82f6', points: saving },
    ],
  };
}

/**
 * Total spending per month — single bar per month.
 * @param {{ excludeEnvelopes?: Set<string>, accounts?: any[] }} [opts]  page filter: envelopes left out; `accounts` so principal paid into a loan is not Spending
 * @returns {Array<{label, value}>}
 */
export function aggregateSpendingByMonth(transactions, range = {}, opts = {}) {
  const monthly = new Map();
  const loans = loanAccountIds(opts.accounts);
  for (const tx of transactions) {
    if (!inRange(tx.date, range.from, range.to)) continue;
    const amt = consumptionTotal(tx, opts.excludeEnvelopes, loans);
    if (!amt) continue;
    const m = tx.date.slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + amt);
  }
  return [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ key: label, label, value: round2(value) }));
}

/**
 * The first month of a `months`-long window ending with `endYm` (inclusive),
 * as 'YYYY-MM'.
 * @param {string} endYm  'YYYY-MM'
 * @param {number} months
 * @returns {string}
 */
export function trailingWindowStart(endYm, months) {
  const [y, m] = endYm.split('-').map(Number);
  const idx = y * 12 + (m - 1) - (months - 1);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/**
 * Average per calendar month of month-labelled points over the `months`
 * months ending with `endYm`. A month with no point counts as zero; the
 * window starts no earlier than `firstYm` (the first month the budget has
 * data), so a young budget is not averaged over months before it existed.
 * Null when the window is empty or holds no points.
 * @param {{ label: string, value: number }[]} points  label 'YYYY-MM'
 * @param {string} endYm
 * @param {number} months
 * @param {string | null} [firstYm]
 * @returns {number | null}
 */
export function trailingMonthlyAverage(points, endYm, months, firstYm = null) {
  let start = trailingWindowStart(endYm, months);
  if (firstYm && firstYm > start) start = firstYm;
  if (start > endYm) return null;
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  const count = (ey * 12 + em) - (sy * 12 + sm) + 1;
  const inWindow = points.filter(p => p.label >= start && p.label <= endYm);
  if (!inWindow.length) return null;
  return round2(inWindow.reduce((s, p) => s + p.value, 0) / count);
}

/**
 * Total saving (money moved to savings/investment/pension) per month —
 * single bar per month, sibling to `aggregateSpendingByMonth`. See
 * `savingAmount` for what counts.
 * @returns {Array<{label, value}>}
 */
export function aggregateSavingByMonth(transactions, accounts, range = {}) {
  const accountsById = new Map();
  for (const a of (accounts || [])) accountsById.set(a.id, a);

  const monthly = new Map();
  for (const tx of transactions) {
    if (!inRange(tx.date, range.from, range.to)) continue;
    const amt = savingEffect(tx, accountsById);
    // Skip on `null` (not a saving row), not on 0 — withdrawals are signed,
    // so a month whose deposits and withdrawals cancel is a real zero, and
    // dropping it would leave a gap in the series exactly where the story is
    // "I saved nothing this month".
    if (amt === null) continue;
    const m = tx.date.slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + amt);
  }
  return [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ key: label, label, value: round2(value) }));
}

/**
 * Current envelope balances (no date filtering — balances are point-in-time).
 * Negative balances kept (shown as overspent).
 * @param {{ excludeEnvelopes?: Set<string> }} [opts]  page filter: envelopes left out
 * @returns {Array<{label, value}>}
 */
export function aggregateEnvelopeBalances(envelopes, transactions, topN = 15, opts = {}) {
  const envelopeById = new Map();
  for (const env of envelopes || []) envelopeById.set(env.id, env);
  const balances = computeEnvelopeBalances(transactions);
  const rows = [...balances.entries()].filter(([id]) => !opts.excludeEnvelopes?.has(id))
    .map(([id, value]) => ({
      key: id,
      label: envelopeDisplayLabel(envelopeById.get(id)),
      value: round2(value),
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (topN && rows.length > topN) return rows.slice(0, topN);
  return rows;
}

/**
 * Budget allocation: planned annual spending per envelope, for pie chart.
 * Sums across all included budget items per envelope.
 * @param {{ excludeEnvelopes?: Set<string> }} [opts]  page filter: envelopes left out
 * @returns {Array<{label, value}>}
 */
export function aggregateBudgetAllocation(envelopes, budgetItems, topN = 10, opts = {}) {
  const envelopeById = new Map();
  for (const env of envelopes || []) envelopeById.set(env.id, env);

  const annualByEnv = new Map(); // envelope_id → annual
  for (const it of budgetItems || []) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (it.kind === 'account_transfer') continue;
    const id = it.envelope_id;
    if (!id || opts.excludeEnvelopes?.has(id)) continue;
    const sched = it.monthly_schedule || {};
    const buffer = Math.abs(it.extra_buffer || 0);
    let annual = buffer;
    for (const m of MONTH_NAMES) {
      const v = sched[m];
      if (v === true)                 annual += Math.abs(it.default_amount || 0);
      else if (typeof v === 'number') annual += Math.abs(v);
    }
    if (annual > 0) annualByEnv.set(id, (annualByEnv.get(id) || 0) + annual);
  }

  const rows = [...annualByEnv.entries()]
    .map(([id, value]) => ({
      key: id,
      label: envelopeDisplayLabel(envelopeById.get(id)),
      value: round2(value),
    }))
    .sort((a, b) => b.value - a.value);
  if (topN && rows.length > topN) {
    const head = rows.slice(0, topN);
    const rest = rows.slice(topN);
    const other = rest.reduce((s, r) => s + r.value, 0);
    // `key: null` rather than absent: every other row carries one, and the
    // chart component (js/ui/charts/) makes a row clickable only when its key
    // is non-null, so an "Other" row stays deliberately unclickable while the
    // row shape stays uniform for anything else reading the list.
    head.push({ key: null, label: `Other (${rest.length})`, value: round2(other) });
    return head;
  }
  return rows;
}
