// js/engine/balances.js — envelope and account balance computation.
//
// The two memoized entry points (`computeEnvelopeBalances`,
// `computeAccountBalances`) are the canonical balance APIs. Use them
// instead of iterating transactions by hand when computing display
// totals, planner inputs, or invariant checks.
//
// Pure functions. No DOM, no I/O. Don't mutate inputs in place between
// calls — the memoization compares by reference identity, and aliasing
// will silently return stale results.

import { round2, validateAmount } from '../utils.js';
import { memoize as _memoizeBalance } from './balance-cache.js';
import { txAccountDelta, txDirection, isPostedTx } from './tx-amounts.js';
import { requireClock, toCents, fromCents } from './_constants.js';

/**
 * The inclusive `YYYY-MM-DD` cutoff an `asOf` option stands for, or null for
 * "no cutoff". A string contributes its first ten characters; a Date its
 * LOCAL calendar day, so a Date late in the evening still means that day
 * (end-of-day semantics). Anything else, including an invalid Date, is no
 * cutoff at all.
 *
 * tx.date is an ISO YYYY-MM-DD string, compared lexicographically against
 * this, to avoid mixing UTC/local-time interpretations of the date.
 *
 * @param {string | Date | null | undefined} asOf
 * @returns {string | null}
 */
function asOfCutoff(asOf) {
  if (!asOf) return null;
  if (typeof asOf === 'string') return asOf.slice(0, 10);
  if (asOf instanceof Date && !isNaN(asOf.getTime())) {
    const y = asOf.getFullYear();
    const m = String(asOf.getMonth() + 1).padStart(2, '0');
    const d = String(asOf.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * Shared status/date filter for the balance APIs.
 *
 * Exported so that `engine/lens.js` — the single seam that resolves a display
 * lens into a transaction array — can reuse the exact same predicate. It is
 * NOT an invitation to pre-filter by hand at a call site: a call site that
 * wants a filtered balance passes `opts` to the public balance functions, and
 * a call site that wants a lens calls `lensTransactions`. Those two, plus the
 * balance functions themselves, are the only intended callers.
 *
 * @param {any[]} transactions
 * @param {{ onlyPosted?: boolean, asOf?: string | Date | null }} [opts]
 */
export function filterTransactions(transactions, { onlyPosted = false, asOf = null } = {}) {
  const cutoffIso = asOfCutoff(asOf);
  return (transactions || []).filter(tx => {
    if (onlyPosted && !isPostedTx(tx)) return false;
    if (cutoffIso && tx.date) {
      if (tx.date.slice(0, 10) > cutoffIso) return false;
    }
    return true;
  });
}

// ─── Envelope balances from transactions ─────────────────────────────────────

/**
 * Given all transactions, compute current balance per envelope.
 * Returns a Map<envelope_id, number>.
 *
 * Transaction types that affect envelopes:
 *   expense:           debit envelope_id by |amount|
 *   income:            credit envelope_id by |amount| (when envelope_id set —
 *                      used for refunds and unallocated-to-Available imports)
 *   fill (add mode):   credit line.envelope_id by line.amount
 *   fill (set mode):   set line.envelope_id to line.amount (absolute, not delta)
 *   envelope_transfer: debit from_envelope_id, credit to_envelope_id
 *   debt_payment:      debit envelope_id (card-side effect is on accounts)
 *   adjustment:        if target === 'envelope', apply amount delta to target_id
 *
 * `opts.onlyPosted=true` ignores transactions whose `status` is anything
 *   other than `'posted'` — i.e. excludes `'scheduled'` rows that have not
 *   actually cleared. Forecast rows (`is_forecast: true`) are always excluded
 *   when this flag is set.
 * `opts.asOf` (Date) excludes any tx dated after end-of-day on that date.
 */
function _computeEnvelopeBalancesRaw(transactions, opts = {}) {
  const { onlyPosted = false, asOf = null } = opts;
  if (asOf || onlyPosted) {
    transactions = filterTransactions(transactions, { onlyPosted, asOf });
  }
  // The result must be what a walk in chronological order (array index as a
  // stable tiebreaker) produces. Almost every effect here is a commutative
  // delta, but `fill { mode: 'set' }` overwrites the running balance —
  // iterating in raw array order would let a later-array, earlier-dated `set`
  // wipe out earlier-array, later-dated postings (e.g. a future expense
  // recorded before today's onboarding "set" fill). This also keeps the
  // result consistent with `computeEnvelopeRunningBalances`, which date-sorts.
  //
  // It used to get there by sorting the whole ledger on every call, which was
  // most of this function's cost on a large ledger (QA 2026-09-23: 11 ms of a
  // 20k-row walk, against under 1 ms for the unsorted account walk). The
  // chronological answer does not need the sort: an envelope ends at its
  // LAST set (by date, then index) plus every delta ordered after that set.
  // So one pass finds each envelope's winning set, and a second, unsorted
  // pass adds the deltas that come after it. A ledger with no set-mode line —
  // everything the app writes today, since `set` is an input shortcut
  // resolved to deltas (js/pages/fill-line.js) — skips the first pass's work
  // entirely. Deltas accumulate in array order rather than date order, which
  // can differ in the last floating-point bit and nowhere a cent can see;
  // `tests/engine/envelope-balance-fast-path.test.js` holds this walk to the
  // sorted one.
  const txs = transactions || [];
  const lastSet = latestSetPerEnvelope(txs);
  // Whole cents while walking (see `toCents`), euros on the way out.
  const balances = new Map();
  for (const [id, s] of lastSet) balances.set(id, toCents(s.value));

  const add = (id, delta) => balances.set(id, (balances.get(id) ?? 0) + toCents(delta));

  // The per-type money rules live in `txEnvelopeEffect` alone. This walk used
  // to carry its own copy, `computeEnvelopeRunningBalances` a third — and the
  // sign convention drifted between them more than once, most memorably a
  // dividend booked the wrong way in only one of the three.
  //
  // `txEnvelopeIds` names the envelopes a transaction touches; `txEnvelopeEffect`
  // says what it does to each. Splitting it that way keeps the arithmetic in one
  // place at the cost of re-scanning a fill's lines once per envelope it funds.
  // That is quadratic in lines per fill and irrelevant in practice: fills carry
  // a few dozen lines at most, a handful of times a year.
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    for (const id of txEnvelopeIds(tx)) {
      const effect = txEnvelopeEffect(tx, id);
      // Sets were settled in the first pass: the winner seeded the map, and
      // every earlier one is overwritten by it.
      if (!effect || effect.mode === 'set') continue;
      const s = lastSet.get(id);
      if (s) {
        const d = dateKey(tx);
        // A delta ordered before the winning set is wiped out by it.
        if (d < s.d || (d === s.d && i < s.i)) continue;
      }
      add(id, effect.amount);
    }
  }

  for (const [id, c] of balances) balances.set(id, fromCents(c));
  return balances;
}

/** The date part of a transaction, as the chronological walk orders by it. */
function dateKey(tx) {
  return (tx.date || '').slice(0, 10);
}

/**
 * Per envelope, the set-mode effect a chronological walk (date, then array
 * index) would apply last, with its position. Only fills carrying a
 * set-mode line are examined, so a ledger without one costs a single scan.
 *
 * @param {readonly any[]} transactions
 * @returns {Map<string, { d: string, i: number, value: number }>}
 */
function latestSetPerEnvelope(transactions) {
  /** @type {Map<string, { d: string, i: number, value: number }>} */
  const out = new Map();
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx || tx.type !== 'fill') continue;
    let hasSet = false;
    for (const line of (tx.lines || [])) {
      if (line && line.mode === 'set') { hasSet = true; break; }
    }
    if (!hasSet) continue;
    const d = dateKey(tx);
    for (const id of txEnvelopeIds(tx)) {
      const effect = txEnvelopeEffect(tx, id);
      if (!effect || effect.mode !== 'set') continue;
      const prev = out.get(id);
      // `i` only grows, so on an equal date the later row wins.
      if (!prev || d >= prev.d) out.set(id, { d, i, value: effect.value });
    }
  }
  return out;
}


/**
 * The envelope ids a transaction touches, each at most once.
 *
 * Deliberately knows only WHERE envelope ids live per type, never what the
 * transaction does to them — that is `txEnvelopeEffect`'s job, and keeping the
 * two apart is what lets the bulk walk and the per-envelope walk share one copy
 * of the money math.
 *
 * Ids are deduplicated because `txEnvelopeEffect` already folds every line for
 * an envelope into a single effect; handing the same id back twice would apply
 * that combined effect twice. Linear `includes` on what is almost always a
 * one-element array beats allocating a Set per transaction.
 *
 * `__none__` is returned like any other id. It is a real bucket for some types
 * and dropped for others, and `txEnvelopeEffect` owns that distinction.
 */
export function txEnvelopeIds(tx) {
  if (!tx) return [];
  const out = [];
  const push = id => { if (id && !out.includes(id)) out.push(id); };

  switch (tx.type) {
    case 'expense':
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        for (const s of tx.envelope_splits) if (s) push(s.envelope_id);
      } else {
        push(tx.envelope_id);
      }
      break;
    case 'income':
    case 'debt_payment':
    case 'investment_transfer':
      push(tx.envelope_id);
      break;
    case 'fill':
      for (const line of (tx.lines || [])) if (line) push(line.envelope_id);
      break;
    case 'envelope_transfer':
      push(tx.from_envelope_id);
      push(tx.to_envelope_id);
      break;
    case 'adjustment':
      if (tx.target === 'envelope') push(tx.target_id);
      break;
    default:
      break;
  }
  return out;
}
export const computeEnvelopeBalances = _memoizeBalance(_computeEnvelopeBalancesRaw, 0, null, 1);

/**
 * One transaction's effect on one envelope, as a typed result:
 *   { mode: 'add', amount }  — a signed delta
 *   { mode: 'set', value }   — overwrites the running balance
 *   null                     — the transaction does not touch this envelope
 *
 * Mirrors the per-type rules `_computeEnvelopeBalancesRaw` applies in bulk;
 * `tests/engine/tx-envelope-effect.test.js` asserts the two agree. Exists
 * because the 12-month projection walks events one at a time and must be able
 * to represent a `fill { mode: 'set' }`, which a plain delta cannot.
 *
 * Two obligations fall on the caller, because this function has no way to
 * enforce them itself:
 *   - Ordering: transactions must be walked date-sorted with a stable index
 *     tiebreaker before folding results (`_computeEnvelopeBalancesRaw` gets the
 *     same answer without sorting; see its comment).
 *     `set`-mode fills are order-sensitive — folding one out of order
 *     silently overwrites the running balance with the wrong value — and
 *     this function only ever sees one transaction, never its neighbours.
 *   - Filtering: this function has no notion of `status`, `is_forecast`,
 *     `onlyPosted` or `asOf`. The bulk walker accepts those as `opts`; a
 *     caller that needs posted-only or as-of semantics must filter the
 *     transaction list before calling this function.
 *
 * The return is a DISCRIMINATED union, and the discriminant is load-bearing:
 * `add` carries a delta to apply, `set` carries the balance to replace it
 * with. A caller that reads `.amount` without checking `.mode` gets
 * `undefined` from a `set` row and turns a running balance into NaN.
 *
 * @param {any} tx
 * @param {string} envelopeId
 * @returns {{ mode: 'add', amount: number } | { mode: 'set', value: number } | null}
 */
export function txEnvelopeEffect(tx, envelopeId) {
  if (!tx || !envelopeId) return null;
  // `__none__` is the sentinel for "deliberately unenveloped". The bulk walker
  // and `computeEnvelopeRunningBalances` both drop it for expense / income /
  // investment_transfer (but NOT for fill, envelope_transfer, debt_payment or
  // adjustment), so this must too or the two disagree on that pseudo-envelope.
  if (envelopeId === '__none__') {
    const dropped = tx.type === 'expense' || tx.type === 'income' || tx.type === 'investment_transfer';
    if (dropped) return null;
  }
  const type = tx.type;

  if (type === 'expense') {
    if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
      let sum = 0;
      let hit = false;
      for (const s of tx.envelope_splits) {
        if (!s || s.envelope_id !== envelopeId) continue;
        const sa = validateAmount(s.amount);
        if (sa === null) continue;
        sum -= sa;
        hit = true;
      }
      return hit ? { mode: 'add', amount: sum } : null;
    }
    if (tx.envelope_id !== envelopeId) return null;
    const amt = validateAmount(tx.amount);
    return amt === null ? null : { mode: 'add', amount: -Math.abs(amt) };
  }

  if (type === 'income') {
    if (tx.envelope_id !== envelopeId) return null;
    const amt = validateAmount(tx.amount);
    return amt === null ? null : { mode: 'add', amount: Math.abs(amt) };
  }

  if (type === 'fill') {
    let mode = 'add';
    let acc = 0;
    let hit = false;
    for (const line of (tx.lines || [])) {
      if (!line || line.envelope_id !== envelopeId) continue;
      const amt = validateAmount(line.amount);
      if (amt === null) continue;
      hit = true;
      if (line.mode === 'set') { mode = 'set'; acc = amt; }
      else                      { acc += amt; }
    }
    if (!hit) return null;
    const total = round2(acc);
    return mode === 'set' ? { mode: 'set', value: total } : { mode: 'add', amount: total };
  }

  if (type === 'envelope_transfer') {
    const amt = validateAmount(tx.amount);
    if (amt === null) return null;
    let delta = 0;
    let hit = false;
    if (tx.from_envelope_id === envelopeId) { delta -= Math.abs(amt); hit = true; }
    if (tx.to_envelope_id   === envelopeId) { delta += Math.abs(amt); hit = true; }
    return hit ? { mode: 'add', amount: delta } : null;
  }

  if (type === 'debt_payment') {
    if (tx.envelope_id !== envelopeId) return null;
    const amt = validateAmount(tx.amount);
    return amt === null ? null : { mode: 'add', amount: -Math.abs(amt) };
  }

  if (type === 'investment_transfer') {
    if (tx.envelope_id !== envelopeId) return null;
    const amt = validateAmount(tx.amount);
    if (amt === null) return null;
    // buy debits the envelope; sell and dividend credit it. An `adjust` is a
    // unit correction with no cash leg, so it moves no envelope money.
    const direction = txDirection(tx);
    if (direction === 'adjust') return null;
    const sign = direction === 'buy' ? -1 : 1;
    return { mode: 'add', amount: sign * Math.abs(amt) };
  }

  if (type === 'adjustment' && tx.target === 'envelope' && tx.target_id === envelopeId) {
    const amt = validateAmount(tx.amount);
    return amt === null ? null : { mode: 'add', amount: amt };
  }

  return null;
}

/**
 * What one transaction SPENT from one envelope, as a signed number: positive is
 * money out, negative is money handed back. Returns 0 when the transaction is
 * not spending for this envelope.
 *
 * Sibling of `txEnvelopeEffect`, deliberately not the same function. The two
 * answer different questions and disagreeing is the whole point:
 *
 *   - `txEnvelopeEffect` asks what the balance did. A fill, an inbound
 *     envelope transfer and a positive adjustment all move it.
 *   - this asks what was SPENT. None of those are spending — a fill is money
 *     arriving, a transfer is money relocating, an adjustment is a correction.
 *     Counting them would turn "you spent €400 on Home this month" into a
 *     number that also includes the €400 you put there.
 *
 * So the set is narrow and closed: expenses (splits carry their own sign, so a
 * negative line credits back), debt payments, and the BUY leg of an investment
 * transfer. Sells and dividends return money to the envelope and are excluded
 * for the same reason fills are.
 *
 * `__none__` spends nothing: it is the sentinel for deliberately unenveloped
 * money, and every "spent per envelope" surface drops it.
 */
export function txEnvelopeSpend(tx, envelopeId) {
  if (!tx || !envelopeId || envelopeId === '__none__') return 0;
  const type = tx.type;

  if (type === 'expense') {
    if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
      let sum = 0;
      for (const s of tx.envelope_splits) {
        if (!s || s.envelope_id !== envelopeId) continue;
        const sa = validateAmount(s.amount);
        if (sa !== null) sum += sa;
      }
      return sum;
    }
    if (tx.envelope_id !== envelopeId) return 0;
    return Math.abs(validateAmount(tx.amount) ?? 0);
  }

  if (type === 'debt_payment') {
    if (tx.envelope_id !== envelopeId) return 0;
    return Math.abs(validateAmount(tx.amount) ?? 0);
  }

  if (type === 'investment_transfer') {
    if (tx.envelope_id !== envelopeId) return 0;
    if (txDirection(tx) !== 'buy') return 0;
    return Math.abs(validateAmount(tx.amount) ?? 0);
  }

  return 0;
}

/**
 * The spend of one transaction, per envelope, as `[envelopeId, amount]` pairs.
 *
 * §2.1 — "how much did I spend?" was answered by four different pieces of
 * code in v1, and they did not agree: the reports module filtered
 * `type === 'expense'`; the dashboard KPI filtered `expense && isPostedTx`;
 * the dashboard donut and trend filtered `expense` with no status test; and
 * the envelopes meter and monthly review used `txEnvelopeSpend`. Four numbers,
 * one question, no indication that they were answering it differently.
 *
 * This is that one rule, in one place, so a fifth copy cannot appear.
 * `txEnvelopeSpend` above is the definition and carries the reasoning; this
 * only adds the two decisions every caller was making for itself:
 *
 *   • posted-only — a scheduled or future-dated row is not money spent. The
 *     dashboard KPI already did this; the reports did not, so one bill dated
 *     2027 inflated every historical chart on the owner's budget.
 *   • per envelope — walking `txEnvelopeIds` means a split expense
 *     contributes to each of its envelopes in its stated proportions rather
 *     than landing whole in one bucket, or in none.
 *
 * A negative split line stays negative: it is a credit and reduces spend.
 *
 * @param {any} tx
 * @returns {Array<[string, number]>}
 */
export function txSpendPairs(tx) {
  if (!isPostedTx(tx)) return [];
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const envId of txEnvelopeIds(tx)) {
    if (!envId || envId === '__none__') continue;
    const amt = txEnvelopeSpend(tx, envId);
    if (amt) out.push([envId, amt]);
  }
  return out;
}

/**
 * Total spend of one transaction across every envelope it touches. Zero for
 * anything that is not spending, and for an expense charged to no envelope —
 * the envelope is the unit, so an unenveloped row has nowhere to land. See
 * `txSpendPairs`.
 */
export function txSpendTotal(tx) {
  let sum = 0;
  for (const [, amt] of txSpendPairs(tx)) sum += amt;
  return sum;
}

/**
 * Month-to-date spend per envelope: `txSpendPairs` over every row dated from
 * the 1st of `today`'s month up to and including `today`.
 *
 * The envelope card sets this against the month's plan ("€224 of €800
 * spent"), which is what makes its "short" figure checkable by hand: the
 * forecast charges the plan minus this month's spend as still to come, so
 * without the spent figure on the card the shortfall has a missing operand.
 * The dashboard card used to be given nothing and drew its meter from
 * `planned − balance`, which counts every fill and reallocation as spending.
 *
 * Future-dated rows stop at `today` for the same reason the forecast's own
 * netting pool does: they have not been spent yet, and the card already
 * reports them on their own "upcoming" line.
 *
 * @param {any[]} transactions
 * @param {Date} today  the clock, supplied by the caller
 * @returns {Map<string, number>}  envelope id → amount, rounded to cents;
 *   envelopes with no spend are absent
 */
export function computeSpentThisMonthByEnvelope(transactions, today) {
  const base = requireClock(today, 'computeSpentThisMonthByEnvelope');
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const month = `${base.getFullYear()}-${pad(base.getMonth() + 1)}`;
  const todayStr = `${month}-${pad(base.getDate())}`;
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const tx of transactions || []) {
    const day = String((tx && tx.date) || '').slice(0, 10);
    if (day.slice(0, 7) !== month || day > todayStr) continue;
    for (const [envId, amt] of txSpendPairs(tx)) {
      out.set(envId, round2((out.get(envId) || 0) + amt));
    }
  }
  return out;
}

/**
 * Spending as the app's TOTALS mean it: "how much did I spend?" on the
 * Overview KPI, its donut and trend, the Reports and the insights summary.
 * That is `txSpendPairs` without investment transfers.
 *
 * Owner decision 2026-09-23 (docs/review/ux-review-2026-09-23.md, U5): money
 * moved into savings or investments is not spending. An investment buy still
 * spends its ENVELOPE (the Investing envelope was funded to buy the fund),
 * which is why the envelope meters and Review keep `txSpendPairs`; but summed
 * into "Spending" it made a month of fund purchases read as a month of
 * overspending, and the Reports counted the same euros as both spent and
 * saved. Those buys are reported under Saving (reports.js, `savingEffect`).
 *
 * @param {any} tx
 * @param {Set<string> | null} [loanIds]  `loanAccountIds(accounts)`
 * @returns {Array<[string, number]>}
 */
export function txConsumptionPairs(tx, loanIds = null) {
  if (!tx || tx.type === 'investment_transfer') return [];
  // Principal paid into a loan account is the same kind of move as an
  // investment buy: a balance-sheet change (a smaller debt, or money lent
  // out), not money consumed. The interest is booked as its own expense and counts. The
  // envelope still spends it (txSpendPairs); only the Spending totals drop
  // it. Callers pass `loanAccountIds(accounts)`; without it a debt payment
  // counts, as a card payment always does.
  if (tx.type === 'debt_payment' && loanIds && loanIds.has(tx.to_account)) return [];
  return txSpendPairs(tx);
}

/**
 * Total of `txConsumptionPairs`: one transaction's contribution to the
 * app's Spending totals.
 *
 * @param {any} tx
 * @param {Set<string> | null} [loanIds]  `loanAccountIds(accounts)`
 * @returns {number}
 */
export function txConsumptionTotal(tx, loanIds = null) {
  let sum = 0;
  for (const [, amt] of txConsumptionPairs(tx, loanIds)) sum += amt;
  return sum;
}

/**
 * For a single envelope, return Map<txId, runningBalanceAfterTx> showing the
 * envelope's cumulative balance immediately after each transaction is applied.
 * Walks `transactions` in date-ascending order (with original-array index as a
 * stable tiebreaker) and applies the same delta logic as
 * `computeEnvelopeBalances`. Only entries for transactions that touch
 * `envelopeId` are present in the returned map.
 */
export function computeEnvelopeRunningBalances(transactions, envelopeId) {
  if (!envelopeId) return new Map();

  const indexed = (transactions || []).map((tx, i) => ({ tx, i }));
  indexed.sort((a, b) => {
    const da = (a.tx.date || '').slice(0, 10);
    const db = (b.tx.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });

  const out = new Map();
  let bal = 0; // whole cents, like the bulk walk

  // Same rules as the bulk walk, from the same function — this used to be a
  // third hand-written copy of the per-type math.
  for (const { tx } of indexed) {
    const effect = txEnvelopeEffect(tx, envelopeId);
    if (!effect) continue;
    bal = effect.mode === 'set' ? toCents(effect.value) : bal + toCents(effect.amount);
    out.set(tx.id, fromCents(bal));
  }

  return out;
}

// ─── Account balances from transactions ──────────────────────────────────────

/**
 * Given all transactions and initial accounts array, compute current balance per account.
 * Returns a Map: accountId → balance
 *
 * Transaction types that affect accounts:
 *   expense:           debit account by |amount|
 *   income:            credit account by amount
 *   fill (new_income): debit source_account by fill total
 *   account_transfer:  debit from_account, credit to_account
 *   adjustment:        if target === 'account', apply delta
 *
 * accounts.json stores the INITIAL balance. Current = initialBalance + effects.
 *
 * `opts.onlyPosted=true` ignores `'scheduled'` rows and forecast rows so the
 *   result reflects what's actually cleared at the bank. The default (no
 *   filter) is the "budget" view — every committed move counts.
 * `opts.asOf` (Date) excludes any tx dated after end-of-day on that date.
 */
function _computeAccountBalancesRaw(accounts, transactions, opts = {}) {
  const { onlyPosted = false, asOf = null } = opts;
  // §4.2 — every other engine entry point tolerates a null collection; this
  // one threw `TypeError: accounts is not iterable`. Seeding from nothing is
  // a legitimate question (a ledger whose accounts have not loaded yet still
  // has transactions), and the answer is an empty map, not a crash.
  const accts = Array.isArray(accounts) ? accounts : [];
  let txs = Array.isArray(transactions) ? transactions : [];
  if (asOf || onlyPosted) {
    txs = filterTransactions(txs, { onlyPosted, asOf });
  }
  // Whole cents while walking (see `toCents`), euros on the way out.
  const balances = new Map();

  // Seed with initial balances
  for (const acct of accts) {
    balances.set(acct.id, toCents(acct.initialBalance ?? 0));
  }

  const get = id => balances.get(id) ?? 0;
  const add = (id, delta) => balances.set(id, get(id) + toCents(delta));

  for (const tx of txs) applyAccountEffects(tx, add);

  for (const [id, c] of balances) balances.set(id, fromCents(c));
  return balances;
}
export const computeAccountBalances = _memoizeBalance(_computeAccountBalancesRaw, 1, 0, 2);

/**
 * Apply one transaction's account-side effects through `add(accountId,
 * delta)`. The per-type account rules, shared by the single-date walk and
 * `computeAccountBalancesAtDates` so the two cannot drift. Calls `add` in the
 * same order the walk always has.
 *
 * @param {any} tx
 * @param {(id: string, delta: number) => void} add
 */
export function applyAccountEffects(tx, add) {
  const type = tx.type;

  if (type === 'expense') {
    const amt = validateAmount(tx.amount);
    if (amt !== null && tx.account) add(tx.account, -Math.abs(amt));

  } else if (type === 'income') {
    const amt = validateAmount(tx.amount);
    if (amt !== null && tx.account) add(tx.account, Math.abs(amt));

  } else if (type === 'fill') {
    if (tx.source === 'new_income' && tx.source_account) {
      let total = 0;
      for (const l of (tx.lines || [])) {
        const a = validateAmount(l.amount);
        if (a !== null) total += a;
      }
      add(tx.source_account, -round2(total));
    }

  } else if (type === 'account_transfer') {
    const amt = validateAmount(tx.amount);
    if (amt !== null) {
      if (tx.from_account) add(tx.from_account, -Math.abs(amt));
      if (tx.to_account)   add(tx.to_account,    Math.abs(amt));
    }

  } else if (type === 'debt_payment') {
    // Debit the funding (bank/cash) account; credit the credit-card account
    // (credit cards are stored with negative balances, so adding |amount|
    // moves toward zero — i.e. reduces debt).
    const amt = validateAmount(tx.amount);
    if (amt !== null) {
      if (tx.from_account) add(tx.from_account, -Math.abs(amt));
      if (tx.to_account)   add(tx.to_account,    Math.abs(amt));
    }

  } else if (type === 'investment_transfer') {
    // Cash-symmetric transfer between two accounts for buy/sell: `amount`
    // is the cash side (fee-inclusive on buys: units*price + fee;
    // fee-exclusive on sells: units*price − fee), so both accounts move
    // by ±amount and the broker fee is absorbed by the investing
    // envelope (see envelope branch above). The investment account's
    // balance reflects net cash poured in — after a round-trip at flat
    // price it retains a residual equal to the fees paid through that
    // account. Dividends are income-shaped: only the cash side
    // (`to_account`) credits; `from_account` names the paying
    // investment account but does not move.
    const amt = validateAmount(tx.amount);
    if (amt !== null && tx.direction === 'dividend') {
      if (tx.to_account) add(tx.to_account, Math.abs(amt));
    } else if (amt !== null) {
      if (tx.from_account) add(tx.from_account, -Math.abs(amt));
      if (tx.to_account)   add(tx.to_account,    Math.abs(amt));
    }

  } else if (type === 'adjustment' && tx.target === 'account') {
    const amt = validateAmount(tx.amount);
    if (amt !== null && tx.target_id) add(tx.target_id, amt);
  }
}

/**
 * Account balances at several dates in one pass: entry `k` of the result is
 * `computeAccountBalances(accounts, transactions, { onlyPosted, asOf:
 * dates[k] })`, in the caller's order.
 *
 * Asking for N month-ends through the single-date API costs N filters and N
 * walks, each its own cache entry (QA 2026-09-23: the dashboard sparkline's
 * six). Here each transaction is assigned once, by binary search, to the
 * earliest checkpoint whose cutoff includes it; the per-checkpoint deltas are
 * then accumulated in date order. Cutoffs follow `asOf` exactly (see
 * `asOfCutoff`): a Date means its local calendar day, inclusive; an undated
 * row counts at every checkpoint; an unusable date means no cutoff.
 *
 * The additions happen in a different order than the single-date walk's, so
 * a result can differ from it in the last floating-point bit — never by
 * anything a cent can see. `tests/engine/account-balance-checkpoints.test.js`
 * holds the two together.
 *
 * @param {any[] | null | undefined} accounts
 * @param {any[] | null | undefined} transactions
 * @param {{ dates?: ReadonlyArray<string | Date | null>, onlyPosted?: boolean }} [opts]
 * @returns {Map<string, number>[]}
 */
function _computeAccountBalancesAtDatesRaw(accounts, transactions, opts = {}) {
  const { dates = [], onlyPosted = false } = opts || {};
  const list = Array.isArray(dates) ? dates : [];
  if (list.length === 0) return [];
  const accts = Array.isArray(accounts) ? accounts : [];
  const txs = Array.isArray(transactions) ? transactions : [];

  const cutoffs = list.map(asOfCutoff);
  // Distinct cutoffs ascending; a checkpoint with no cutoff sees everything,
  // so it is one extra level after the last dated one.
  const levels = [...new Set(cutoffs.filter(c => c !== null))].sort();
  const openLevel = cutoffs.includes(null) ? levels.length : -1;
  /** @type {Map<string, number>[]} */
  const deltas = Array.from({ length: levels.length + (openLevel >= 0 ? 1 : 0) }, () => new Map());

  for (const tx of txs) {
    if (onlyPosted && !isPostedTx(tx)) continue;
    let level = 0;
    if (tx.date) {
      const d = tx.date.slice(0, 10);
      // First level whose cutoff is on or after the row's date.
      let lo = 0, hi = levels.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (levels[mid] < d) lo = mid + 1; else hi = mid;
      }
      level = lo;
      if (level === levels.length && openLevel < 0) continue; // after every cutoff
    }
    const bucket = deltas[level];
    applyAccountEffects(tx, (id, delta) => bucket.set(id, (bucket.get(id) ?? 0) + toCents(delta)));
  }

  // Whole cents throughout, like the single-date walk, so the two agree
  // exactly rather than to the last floating-point bit.
  const running = new Map();
  for (const acct of accts) running.set(acct.id, toCents(acct.initialBalance ?? 0));
  const snapshots = deltas.map(bucket => {
    for (const [id, delta] of bucket) running.set(id, (running.get(id) ?? 0) + delta);
    const snap = new Map();
    for (const [id, c] of running) snap.set(id, fromCents(c));
    return snap;
  });
  const levelIndex = new Map(levels.map((c, i) => [c, i]));
  return cutoffs.map(c => snapshots[c === null ? openLevel : /** @type {number} */ (levelIndex.get(c))]);
}
export const computeAccountBalancesAtDates = _memoizeBalance(_computeAccountBalancesAtDatesRaw, 1, 0, 2, 'atDates:');

/**
 * Like computeAccountBalances, but ignoring any transaction dated after `asOf`
 * (end-of-day on `asOf`). Thin wrapper over computeAccountBalances({ asOf }).
 * Used for the "current" balance vs the full/"budget" balance, which includes
 * future-dated transactions.
 */
export function computeAccountBalancesAsOf(accounts, transactions, asOf) {
  return computeAccountBalances(accounts, transactions, { asOf });
}

/**
 * Net worth across the budget's accounts: every non-archived account's
 * balance, split so each account lands in exactly one part and the parts sum
 * to `total`. The Overview's "Net worth (accounts)" card (owner decision
 * 2026-09-24): it is the Accounts page total, broken down.
 *
 *   spending   — `isSpendingAccount` (cash, current accounts, credit cards,
 *                or any account opted in); card debt counts against it
 *   savings    — other `savings` accounts
 *   investment — other `investment` accounts, pension wrappers excepted
 *   pension    — `investment` accounts flagged `pensionInsurance`
 *   assets     — asset accounts (a home, gold, …; a debt kept as an asset
 *                account is one with a negative value)
 *   loansGiven — loan-given accounts: money lent out, owed back
 *   debts      — loan accounts: mortgages and other loans owed
 *   other      — the rest, e.g. a bank-type account opted out of spending
 *
 * Only accounts: anything not kept as an account (an asset account included)
 * is not in it, hence the "(accounts)" in the label. `opts` is forwarded to
 * `computeAccountBalances`; callers pass lens-resolved transactions.
 *
 * @param {any[]} accounts
 * @param {any[]} transactions
 * @param {{ onlyPosted?: boolean, asOf?: string | Date | null }} [opts]
 * @returns {{ total: number, spending: number, savings: number, investment: number, pension: number, assets: number, loansGiven: number, debts: number, other: number }}
 */
export function computeNetWorth(accounts, transactions, opts = {}) {
  return netWorthFromBalances(accounts, computeAccountBalances(accounts, transactions, opts));
}

/**
 * The net-worth part an account counts under — the one bucketing rule shared
 * by `netWorthFromBalances` and the Net worth page's quick groups.
 * @param {any} a
 * @returns {'spending' | 'savings' | 'investment' | 'pension' | 'assets' | 'loansGiven' | 'debts' | 'other'}
 */
export function netWorthPartOf(a) {
  if (!a) return 'other';
  // Loans get lines of their own: lumped with the assets, money lent out
  // silently netted against a mortgage.
  if (isLoanGivenAccount(a)) return 'loansGiven';
  if (isLoanAccount(a)) return 'debts';
  if (isAssetAccount(a)) return 'assets';
  if (isSpendingAccount(a)) return 'spending';
  if (a.type === 'savings') return 'savings';
  if (a.type === 'investment') return a.pensionInsurance ? 'pension' : 'investment';
  return 'other';
}

/**
 * The `computeNetWorth` split over an already-computed balance map.
 *
 * @param {any[]} accounts
 * @param {Map<string, number>} bal
 * @returns {{ total: number, spending: number, savings: number, investment: number, pension: number, assets: number, loansGiven: number, debts: number, other: number }}
 */
export function netWorthFromBalances(accounts, bal) {
  const out = { total: 0, spending: 0, savings: 0, investment: 0, pension: 0, assets: 0, loansGiven: 0, debts: 0, other: 0 };
  for (const a of accounts || []) {
    if (!a || a.archived) continue;
    // Same fallback as the Accounts page total, so the two agree.
    const v = bal.get(a.id) ?? (Number(a.initialBalance) || 0);
    const part = netWorthPartOf(a);
    out[part] += v;
    out.total += v;
  }
  return out;
}

/**
 * Net worth and its parts at each of `dates` (e.g. month-ends), in one walk
 * of the ledger. Accounts archived today are left out of every point, as
 * they are of today's figure, so the series ends exactly on
 * `computeNetWorth` for the same transactions.
 *
 * @param {any[]} accounts
 * @param {any[]} transactions
 * @param {ReadonlyArray<string>} dates  YYYY-MM-DD, any order
 * @returns {Array<{ date: string, total: number, spending: number, savings: number, investment: number, pension: number, assets: number, loansGiven: number, debts: number, other: number }>}
 */
export function computeNetWorthHistory(accounts, transactions, dates) {
  const snaps = computeAccountBalancesAtDates(accounts, transactions, { dates });
  return snaps.map((bal, k) => ({ date: dates[k], ...netWorthFromBalances(accounts, bal) }));
}

/**
 * Each account's average monthly net inflow over the `months` before `today`:
 * the contribution a net-worth projection carries forward. Posted rows only,
 * and no `adjustment` rows, so a revaluation (a house's new value, a fund's
 * market move) is not mistaken for money put in.
 *
 * @param {any[]} accounts
 * @param {any[]} transactions
 * @param {Date} today
 * @param {number} [months]
 * @returns {Map<string, number>}
 */
export function averageMonthlyContribution(accounts, transactions, today, months = 12) {
  requireClock(today, 'averageMonthlyContribution');
  const end = asOfCutoff(today) || '';
  const startDate = new Date(today.getFullYear(), today.getMonth() - months, today.getDate());
  const start = asOfCutoff(startDate) || '';
  /** @type {Map<string, number>} */
  const sums = new Map();
  for (const a of accounts || []) sums.set(a.id, 0);
  for (const tx of transactions || []) {
    if (!tx || tx.type === 'adjustment' || !isPostedTx(tx)) continue;
    const d = (tx.date || '').slice(0, 10);
    if (!d || d <= start || d > end) continue;
    applyAccountEffects(tx, (id, delta) => {
      if (sums.has(id)) sums.set(id, (sums.get(id) ?? 0) + delta);
    });
  }
  for (const [id, v] of sums) sums.set(id, round2(v / months));
  return sums;
}

/**
 * A long-horizon net-worth projection: every non-archived account grows
 * monthly by its expected yearly rate and receives its monthly contribution.
 * Year 0 is the starting balances.
 *
 * Deliberately separate from the Forecast lens (owner decision 2026-09-24):
 * the lens projects booked and scheduled money only; growth rates are
 * assumptions, and over the lens's months they are noise, while over years
 * they are the point.
 *
 * `shiftPct` moves every account that HAS a rate by that many percentage
 * points (the low/high lines); an account with no rate (cash, a current
 * account) earns nothing in every line.
 *
 * `lumps` are one-off amounts at a month (1-based from the start): booked
 * transactions dated inside the projection that no contribution models, such
 * as a scheduled inheritance years out (`simulate`'s `laterBooked`). Each is
 * added at the end of its month, after that month's growth, so it compounds
 * from the next month on.
 *
 * @param {object} input
 * @param {any[]} input.accounts
 * @param {Map<string, number>} input.balances        starting value per account
 * @param {Map<string, number | null>} input.growthPct  expected % per year, null = none
 * @param {Map<string, number>} input.contribution     per month, in money
 * @param {number} input.years
 * @param {number} [input.shiftPct]
 * @param {ReadonlyArray<{ month: number, accountId: string, amount: number }>} [input.lumps]
 * @param {Map<string, number[]> | null} [input.paths]  an account's balance at each month
 *   end, taken as is (no growth, no contribution); a lump on it is carried on
 *   top. Index `pathOffset + m` is the end of projection month m; past its
 *   end the last value holds.
 * @param {number} [input.pathOffset]
 * @returns {Array<{ year: number, total: number }>}
 */
export function projectNetWorth({ accounts, balances, growthPct, contribution, years, shiftPct = 0, lumps = [], paths = null, pathOffset = 0 }) {
  const live = (accounts || []).filter(a => a && !a.archived).map(a => {
    const g = growthPct.get(a.id);
    const rate = Number.isFinite(g) ? /** @type {number} */ (g) + shiftPct : 0;
    return {
      id: a.id,
      value: balances.get(a.id) ?? (Number(a.initialBalance) || 0),
      factor: Math.pow(1 + rate / 100, 1 / 12),
      monthly: contribution.get(a.id) ?? 0,
      loan: isLoanAccount(a) ? 'owed' : isLoanGivenAccount(a) ? 'given' : null,
      path: paths?.get(a.id) ?? null,
      lumped: 0,
    };
  });
  const byId = new Map(live.map(x => [x.id, x]));
  /** @type {Map<number, Array<{ accountId: string, amount: number }>>} */
  const due = new Map();
  for (const l of lumps || []) {
    if (!l || !Number.isFinite(l.amount) || !Number.isInteger(l.month)) continue;
    const list = due.get(l.month) ?? [];
    list.push(l);
    due.set(l.month, list);
  }
  const total = () => round2(live.reduce((s, x) => s + x.value, 0));
  const out = [{ year: 0, total: total() }];
  let month = 0;
  for (let y = 1; y <= years; y++) {
    for (let m = 0; m < 12; m++) {
      month++;
      for (const x of live) {
        if (x.path && x.path.length) {
          x.value = x.path[Math.min(pathOffset + month, x.path.length - 1)] + x.lumped;
          continue;
        }
        x.value = x.value * x.factor + x.monthly;
        // A loan paid off stays at zero: repayments stop, they do not turn
        // a debt into savings, or a loan given into one owed.
        if (x.loan === 'owed' && x.value > 0) x.value = 0;
        if (x.loan === 'given' && x.value < 0) x.value = 0;
      }
      for (const l of due.get(month) ?? []) {
        const x = byId.get(l.accountId);
        if (x) { x.value += l.amount; if (x.path) x.lumped += l.amount; }
      }
    }
    out.push({ year: y, total: total() });
  }
  return out;
}

/**
 * Sum of balances across savings + investment accounts. Returns
 * { total, savings, investment, pension, count } — the dashboard Savings
 * KPI's breakdown. `opts` is forwarded verbatim to `computeAccountBalances`,
 * so the caller decides the lens; the dashboard passes lens-resolved
 * transactions and no opts, which keeps this KPI consistent with every other
 * balance on the page. `pension` splits out investment-type accounts flagged
 * `pensionInsurance` (e.g. Mandatum pension wrappers) — locked pension
 * money, not sellable like the rest of `investment`. `type` stays
 * 'investment' on those accounts for every other purpose (forecasting,
 * off-budget math, envelope exclusion); this split is display-only.
 */
export function computeSavingsSplit(accounts, transactions, opts = {}) {
  const bal = computeAccountBalances(accounts, transactions, opts);
  let savings = 0;
  let investment = 0;
  let pension = 0;
  let count = 0;
  for (const a of (accounts || [])) {
    if (a.archived) continue;
    if (a.type === 'savings') {
      savings += bal.get(a.id) ?? 0;
      count++;
    } else if (a.type === 'investment') {
      if (a.pensionInsurance) pension += bal.get(a.id) ?? 0;
      else investment += bal.get(a.id) ?? 0;
      count++;
    }
  }
  return { total: savings + investment + pension, savings, investment, pension, count };
}

/**
 * For a single account, return Map<txId, runningBalanceAfterTx> showing the
 * account's cumulative balance immediately after each transaction is applied.
 * Walks `transactions` in date-ascending order (with original-array index as a
 * stable tiebreaker), seeding from the account's initialBalance and applying
 * `txAccountDelta` per row. Only entries for transactions that touch
 * `accountId` are present in the returned map.
 */
export function computeAccountRunningBalances(accounts, transactions, accountId) {
  if (!accountId) return new Map();
  const acct = (accounts || []).find(a => a.id === accountId);
  let bal = toCents(acct?.initialBalance ?? 0); // whole cents, like the walk

  const indexed = (transactions || []).map((tx, i) => ({ tx, i }));
  indexed.sort((a, b) => {
    const da = (a.tx.date || '').slice(0, 10);
    const db = (b.tx.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });

  const out = new Map();
  for (const { tx } of indexed) {
    const delta = txAccountDelta(tx, accountId);
    if (delta === 0) continue;
    bal += toCents(delta);
    out.set(tx.id, fromCents(bal));
  }
  return out;
}

// ─── Unallocated ─────────────────────────────────────────────────────────────

/**
 * Unallocated = sum(account balances) - sum(envelope balances)
 * Positive = money not yet assigned to envelopes (fine)
 * Negative = envelopes exceed accounts (WARNING - overallocated)
 *
 * `accounts` is optional. When provided, accounts whose `type` is
 * `'investment'` are excluded from the account-balance side: investment
 * holdings are tracked for net-worth purposes but aren't "available cash"
 * for the envelope budget, so they shouldn't inflate unallocated.
 */
// Account types that are spending accounts unless the account says otherwise.
const SPENDING_TYPES = new Set(['bank', 'cash', 'credit_card']);

/**
 * An asset (or debt) held outside the budget: a home, gold, a car, a mortgage
 * (a negative value). Its balance is its latest recorded value, kept with
 * dated `adjustment` rows ("value updates"). It counts toward net worth and
 * nothing else: never the zero-sum identity (so never Unallocated), never a
 * spending, crisis-cash or saving figure, and it is not offered where money
 * is paid from or to (owner request 2026-09-24).
 *
 * @param {{ type?: string } | null | undefined} account
 * @returns {boolean}
 */
export function isAssetAccount(account) {
  return account?.type === 'asset';
}

/**
 * A loan the household owes (a mortgage, a car or student loan): its balance
 * is negative, the amount still owed. Like an asset account it sits outside
 * the zero-sum identity, so a principal payment into it is paid from an
 * envelope (a `debt_payment` row) and leaves Unallocated alone, the same way
 * an investment buy does. Unlike an asset account it is paid to, and its
 * balance moves with those payments rather than by revaluation. Never a
 * spending or crisis-cash account.
 *
 * @param {{ type?: string } | null | undefined} account
 * @returns {boolean}
 */
export function isLoanAccount(account) {
  return account?.type === 'loan';
}

/**
 * A loan the household has GIVEN (to family, a friend): money owed to it.
 * The mirror of `isLoanAccount`: its balance is positive, the amount still to
 * be repaid, and it sits outside the zero-sum identity for the same reason,
 * so lent-out money never reads as cash the budget can assign. Lending is a
 * `debt_payment` into it, paid from an envelope (Unallocated stays put); a
 * repayment is a transfer out of it, which lands in Unallocated; interest
 * received is income. Never a spending or crisis-cash account.
 *
 * @param {{ type?: string } | null | undefined} account
 * @returns {boolean}
 */
export function isLoanGivenAccount(account) {
  return account?.type === 'loan_given';
}

/**
 * The ids of the loan accounts in `accounts`, owed and given alike, for
 * `txConsumptionPairs`: money moved into either is a balance-sheet change,
 * not spending.
 * @param {any[] | null | undefined} accounts
 * @returns {Set<string>}
 */
export function loanAccountIds(accounts) {
  return new Set((accounts || []).filter(a => isLoanAccount(a) || isLoanGivenAccount(a)).map(a => a.id));
}

/**
 * Whether an account of this type is a spending account when it has no
 * explicit `spending` flag: bank, cash and credit card are; savings and
 * investment accounts (pension wrappers included) are not.
 *
 * @param {string | undefined} type
 * @returns {boolean}
 */
export function spendingByDefault(type) {
  return SPENDING_TYPES.has(type || 'bank');
}

/**
 * Whether an account is one the household spends from day to day: the scope
 * of the Overview's spending-accounts card, Age of Money, and the runway.
 * An explicit `spending: true|false` on the account wins (a bank-type
 * brokerage cash account can opt out); otherwise `spendingByDefault`.
 *
 * Owner decision 2026-09-23 (docs/review/ux-review-2026-09-23.md, U2): the
 * spending accounts are cash, the current accounts and the credit cards, and
 * pension is never part of the runway. Before this the runway counted every
 * non-credit-card account, pension included, and the Stress page every
 * account, so the same budget showed 55 days on one page and 145 months on
 * the other.
 *
 * @param {{ type?: string, spending?: boolean } | null | undefined} account
 * @returns {boolean}
 */
export function isSpendingAccount(account) {
  if (!account || isAssetAccount(account) || isLoanAccount(account) || isLoanGivenAccount(account)) return false;
  if (typeof account.spending === 'boolean') return account.spending;
  return spendingByDefault(account.type);
}

/**
 * Whether an account is money the household could live on in a crisis: the
 * Stress page's "cash on hand". Spending accounts always are. Otherwise an
 * explicit `crisisCash: true|false` wins, and the default is savings-type
 * accounts only (owner decision 2026-09-24: savings and the emergency fund
 * exist for exactly this; investments and pension do not count).
 *
 * The flag exists for savings-type accounts that are not emergency money,
 * such as a "Loans to Others" account (ux-review U2 follow-up).
 *
 * History: the Stress page used to count every account, pension included, so
 * one budget read 57 days of runway on the Overview and ~146 months on the
 * Stress page (ux-review U2). The Overview's runway "at current spend" stays
 * the spending accounts alone.
 *
 * @param {{ type?: string, spending?: boolean, crisisCash?: boolean } | null | undefined} account
 * @returns {boolean}
 */
export function isCrisisCashAccount(account) {
  if (!account || isAssetAccount(account) || isLoanAccount(account) || isLoanGivenAccount(account)) return false;
  if (isSpendingAccount(account)) return true;
  if (typeof account.crisisCash === 'boolean') return account.crisisCash;
  return account.type === 'savings';
}

/**
 * Does this account's balance participate in the zero-sum identity?
 *
 *   Σ identity accounts = Σ envelopes + unallocated
 *
 * Investment accounts do not: their value is holdings at market price, not
 * money waiting to be assigned to an envelope, and counting it would report
 * a portfolio as unassigned cash. Asset accounts do not either, for the same
 * reason: a house's value is not money to assign, and nor are loan accounts:
 * a mortgage's balance is debt, not a shortfall in the budget's cash, and
 * money lent out is not cash in hand.
 * Everything else does.
 *
 * The scope is a named rule because it has to be applied in more than one
 * place — `computeUnallocated` and anything that prints the account side of
 * the identity beside it — and applying two scopes to one screen is how the
 * dashboard came to show a total, an assigned figure and an unallocated
 * figure of which no two explained the third.
 */
export function countsTowardIdentity(account) {
  return !!account && account.type !== 'investment' && !isAssetAccount(account)
    && !isLoanAccount(account) && !isLoanGivenAccount(account);
}

/**
 * The identity's account side: the total of every account balance that
 * `countsTowardIdentity` admits.
 *
 * Print THIS beside `computeUnallocated`, never the sum of all balances —
 * `total − assigned === unallocated` is then true on the screen, which is the
 * whole claim the card is making.
 *
 * Deliberately unrounded. Rounding a subtotal and then adding is not the same
 * as adding and then rounding, so a rounded return here would make
 * `identity + investment === every account` false by a cent — and it would
 * put that cent inside `computeUnallocated`, which rounds once at the end.
 * Display rounds anyway: every caller prints through `fmt`.
 *
 * @param {Map<string, number>} accountBalances
 * @param {any[] | null} [accounts]
 */
export function identityAccountTotal(accountBalances, accounts = null) {
  // Summed in whole cents, so the total is exact (see `toCents`).
  let total = 0;
  if (!Array.isArray(accounts)) {
    for (const v of accountBalances.values()) total += toCents(v);
    return fromCents(total);
  }
  for (const a of accounts) {
    if (!countsTowardIdentity(a)) continue;
    total += toCents(accountBalances.get(a.id) ?? 0);
  }
  return fromCents(total);
}

/**
 * @param {Map<string, number>} accountBalances
 * @param {Map<string, number>} envelopeBalances
 * @param {any[] | null} [accounts]  when given, investment accounts are
 *   excluded — see `countsTowardIdentity`
 */
export function computeUnallocated(accountBalances, envelopeBalances, accounts = null) {
  let total = toCents(identityAccountTotal(accountBalances, accounts));
  for (const v of envelopeBalances.values()) total -= toCents(v);
  return fromCents(total);
}

/**
 * The effect a month-end rollover replays for a fill that belongs to a later
 * month but is dated in the closing one. A stored fill is add-only: a
 * template's set line is stored as its delta, with the target it resolved
 * against in `set_target`. Its balance effect is that delta
 * (`txEnvelopeEffect`), but the sweep replays it as the target: a fill that
 * topped the envelope up to 300 still leaves it on 300 once the month's own
 * money is swept, as a stored set line did.
 *
 * @param {any} tx
 * @param {string} envelopeId
 * @param {{ mode: 'add', amount: number } | { mode: 'set', value: number } | null} [effect]
 *   the balance effect when the caller already has it
 * @returns {{ mode: 'add', amount: number } | { mode: 'set', value: number } | null}
 */
export function txRolloverReplayEffect(tx, envelopeId, effect = txEnvelopeEffect(tx, envelopeId)) {
  if (!effect || tx?.type !== 'fill' || !Array.isArray(tx.lines)) return effect;
  let target = null;
  for (const line of tx.lines) {
    if (!line || line.envelope_id !== envelopeId) continue;
    const v = validateAmount(line.set_target);
    if (v !== null) target = v;
  }
  return target === null ? effect : { mode: 'set', value: round2(target) };
}
