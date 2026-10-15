// js/engine/tx-amounts.js — transaction amount sign helpers + normalisation.
//
// `tx.amount` stores a positive magnitude for type-signed transactions and a
// meaningful sign only for `adjustment` rows, but historical data written
// before normalisation may still carry stray signs. Always go through these
// helpers — never read `tx.amount` directly when computing deltas or display
// amounts.
//
// Pure functions. No DOM, no I/O.

import { validateAmount, round2 } from '../utils.js';

/**
 * The direction of an `investment_transfer`, resolved to one of the four the
 * engine knows: `'buy'` (the default, and what an absent or unrecognised
 * direction means), `'sell'`, `'dividend'`, `'adjust'`.
 *
 * This ladder was written out six times across balances.js, holdings.js,
 * monthly-review.js and reports.js, and the copies had already diverged: three
 * of them omitted `adjust` and so resolved such a row to `'buy'`. A SEVENTH
 * copy, in monthly-review.js, omitted `dividend` — and that was the audit's
 * defect 1, a dividend debited from an envelope by the review while
 * `computeEnvelopeBalances` credited it. Opposite signs for the same row,
 * from two functions reading the same field.
 *
 * `adjust` is a manual holdings correction (`state.meta.investments.manualRows`)
 * and never appears in `state.transactions` today, so unifying the three-way
 * copies onto this changes no number on any existing budget. It changes what
 * happens the day such a row does appear: an adjustment stops counting as a
 * purchase — no envelope debit, no spend, no saving — which is the answer the
 * four-way copies already gave.
 */
export function txDirection(tx) {
  switch (tx?.direction) {
    case 'sell': return 'sell';
    case 'dividend': return 'dividend';
    case 'adjust': return 'adjust';
    default: return 'buy';
  }
}

/**
 * Magnitude of a transaction's amount, sign-stripped. Returns 0 for malformed
 * input. Use anywhere you'd previously written `Math.abs(tx.amount)`.
 */
export function txAbsAmount(tx) {
  if (!tx) return 0;
  const amt = validateAmount(tx.amount);
  return amt === null ? 0 : Math.abs(amt);
}

/**
 * True when a transaction counts as posted (real, settled activity).
 * Missing `status` means posted — manual entry never sets the field; only
 * scheduling/forecast/import paths do. The single definition for the
 * "posted lens" used by balances, KPIs, and age-of-money.
 */
export function isPostedTx(tx) {
  if (!tx) return false;
  if (tx.is_forecast) return false;
  return !tx.status || tx.status === 'posted';
}

/**
 * Every transaction type the engine gives an effect to. A row whose `type`
 * is not in this list moves no money anywhere: `txAccountDelta` and the
 * envelope walk in balances.js both fall through to zero for it, so a typo'd
 * `'expnese'` silently vanishes from every balance.
 *
 * The single contract for "is this a real type": `runInvariantCheck` reports
 * rows outside it (`unknownTypes`), and the session's commit checks refuse to write
 * a row outside it that is new or whose type is changing. Adding a type means
 * teaching the engine's walkers about it AND adding it here.
 *
 * @type {ReadonlyArray<string>}
 */
export const TX_TYPES = Object.freeze([
  'expense', 'income', 'account_transfer', 'debt_payment',
  'investment_transfer', 'envelope_transfer', 'fill', 'adjustment',
]);

const TX_TYPE_SET = new Set(TX_TYPES);

/**
 * True when `type` is one of `TX_TYPES`.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownTxType(type) {
  return typeof type === 'string' && TX_TYPE_SET.has(type);
}

// Types whose `amount` field carries a meaningful sign. Everything else
// derives its sign from `type` alone (expense subtracts, income adds,
// transfers move between accounts, etc.) and stores `amount` as a
// positive magnitude.
const SIGNED_AMOUNT_TYPES = new Set(['adjustment']);

/**
 * Normalize `tx.amount` to the canonical convention: a positive magnitude
 * for type-signed transactions (expense/income/transfers/etc.); preserved
 * sign for transactions where ± is semantically meaningful (adjustments).
 *
 * Use at the write boundary (see js/session/commit-checks.js). Returns the
 * original object if nothing needs to change so reference equality is
 * preserved for unchanged rows.
 */
export function normalizeTxAmount(tx) {
  if (!tx || typeof tx !== 'object') return tx;
  if (tx.amount === undefined || tx.amount === null) return tx;
  const n = validateAmount(tx.amount);
  if (n === null) return tx;
  if (SIGNED_AMOUNT_TYPES.has(tx.type)) return tx;
  if (n >= 0) return tx;
  return { ...tx, amount: Math.abs(n) };
}

/**
 * Map an array of transactions through normalizeTxAmount. Preserves row
 * identity when no change is needed; returns the input array unchanged
 * when nothing in it needs normalising (so callers can compare arrays
 * by reference).
 */
export function normalizeTransactionsForWrite(transactions) {
  if (!Array.isArray(transactions)) return transactions;
  let changed = false;
  const out = transactions.map((tx) => {
    const normalized = normalizeTxAmount(tx);
    if (normalized !== tx) changed = true;
    return normalized;
  });
  return changed ? out : transactions;
}

/**
 * Magnitude of an investment_transfer's broker fee, sign-stripped. Returns 0
 * when the field is missing/malformed. Mirrors `txAbsAmount`'s discipline.
 */
export function txFeeAmount(tx) {
  if (!tx) return 0;
  const f = validateAmount(tx.fee);
  return f === null ? 0 : Math.abs(f);
}

/**
 * Project annual interest for a balance against a tiered schedule. Tiers
 * use exclusive upper limits. In full-balance mode, the matching tier's rate
 * applies to the entire balance. By default, tiers are applied progressively;
 * each tier covers the portion of the
 * balance from the previous tier's `upTo` up to this tier's `upTo`. A tier
 * with `upTo` null/missing/Infinity captures everything above the previous
 * cap. `rate` is annual percent (e.g. 1.5 = 1.5% / year).
 *
 * Returns an estimate rounded to two decimals. Handles missing/malformed
 * inputs by skipping silently and returning 0.
 *
 * @param {number} balance
 * @param {Array<{upTo?: number|null, rate: number}>} tiers
 * @param {'progressive'|'full-balance'} [mode]
 */
export function computeAnnualInterest(balance, tiers, mode = 'progressive') {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  let remaining = balance;
  let prevCap = 0;
  let total = 0;
  for (const tier of tiers) {
    if (!tier) continue;
    const rateRaw = Number(tier.rate);
    const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 0;
    const capRaw = tier.upTo;
    const cap = capRaw == null || !Number.isFinite(Number(capRaw))
      ? Infinity
      : Number(capRaw);
    if (mode === 'full-balance') {
      if (cap > prevCap && balance >= prevCap && balance < cap) {
        return Math.round(balance * rate) / 100;
      }
      prevCap = Math.max(prevCap, cap);
      continue;
    }
    const tierWidth = Math.max(0, cap - prevCap);
    const portion = Math.min(remaining, tierWidth);
    if (portion > 0 && rate > 0) {
      total += portion * rate / 100;
    }
    remaining -= portion;
    prevCap = cap;
    if (remaining <= 0) break;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Signed delta a transaction applies to a specific account. The single source
 * of truth for all account-side balance math (use this when iterating tx lists
 * by hand, e.g. for reconciliation, sparkline series, audit trails).
 *
 * Returns 0 when the transaction does not touch `accountId`.
 */
export function txAccountDelta(tx, accountId) {
  if (!tx) return 0;
  const type = tx.type;
  const amt = txAbsAmount(tx);
  if (type === 'expense' && tx.account === accountId) return -amt;
  if (type === 'income'  && tx.account === accountId) return  amt;
  if (type === 'account_transfer' || type === 'debt_payment') {
    // A leg that returns to the account it left moves nothing. Without this,
    // the first `if` wins and the row reads as a pure debit — which is what
    // the bulk walk in balances.js has always disagreed with, since it adds
    // both legs and nets them to zero. `runInvariantCheck` reports such a row
    // as `selfTransferAccount`, but until the owner fixes it the Accounts page
    // and the reconcile dialog must at least be wrong in the same direction,
    // and they are better off both being right.
    if (tx.from_account === tx.to_account) return 0;
    if (tx.from_account === accountId) return -amt;
    if (tx.to_account   === accountId) return  amt;
  }
  if (type === 'investment_transfer') {
    // Cash-symmetric for buy/sell: both accounts move by ±amount. `amount`
    // is the cash side (fee-inclusive on buy, fee-exclusive on sell), so
    // the broker fee is absorbed by the investing envelope, not the
    // accounts. Dividends are income-shaped: the cash account credits by
    // `amount`, and `from_account` (the investment account that paid)
    // doesn't move because the cash came from outside the budget.
    if (tx.direction === 'dividend') {
      if (tx.to_account === accountId) return amt;
      return 0;
    }
    if (tx.from_account === tx.to_account) return 0; // as above
    if (tx.from_account === accountId) return -amt;
    if (tx.to_account   === accountId) return  amt;
  }
  if (type === 'fill' && tx.source === 'new_income' && tx.source_account === accountId) {
    let total = 0;
    for (const l of (tx.lines || [])) {
      const a = validateAmount(l.amount);
      if (a !== null) total += a;
    }
    return -round2(total);
  }
  if (type === 'adjustment' && tx.target === 'account' && tx.target_id === accountId) {
    const raw = validateAmount(tx.amount);
    return raw === null ? 0 : raw;
  }
  return 0;
}

/**
 * Net effect of one transaction across a SET of accounts — money that actually
 * entered or left them, as opposed to money that merely moved between them.
 *
 * A transfer between two accounts in the set nets to zero, which is the whole
 * point: summing per-row DISPLAY amounts instead treats every non-expense as a
 * credit, so a day holding one €400 own-account transfer reads +€400 when
 * nothing arrived. Aggregating display amounts across mixed types produces a
 * number that is not a quantity of anything.
 *
 * Delegates per account rather than re-deriving the type rules — there are
 * already too many copies of envelope/account sign logic in this codebase, and
 * every one of them has drifted at least once.
 *
 * `accountIds` is any iterable of ids (a Set is the usual caller).
 */
export function txNetAccountDelta(tx, accountIds) {
  if (!tx || !accountIds) return 0;
  let total = 0;
  for (const id of accountIds) total += txAccountDelta(tx, id);
  return round2(total);
}
