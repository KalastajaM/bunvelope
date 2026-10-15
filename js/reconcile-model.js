// js/reconcile-model.js — the decisions the reconcile dialogs make, with no
// DOM attached.
//
// `js/reconcile.js` is two long DOM builders, and every figure the user
// reconciles against used to be computed inside their closures: which rows
// are candidates, what has already cleared, what the gap to the statement is,
// what adjustment closes it, and what the transaction list looks like
// afterwards. None of that could be tested without a browser, so none of it
// was — in a module that writes money.
//
// Same argument, and the same fix, as `js/pages/transactions-filter.js` and
// `js/core/effective-txs.js`: the rules move out, the wiring stays.
//
// Pure functions. No DOM, no I/O, no `state`.

import { txAccountDelta, txAbsAmount, CENT_EPSILON, paymentSettles, forecastKey, reconciledLedgerBalance } from './engine.js';
import { round2 } from './utils.js';

// A gap smaller than half a cent is a rounding artefact, not a difference.
// Every threshold in the reconcile flow is this one — the dialog's "balanced"
// colour, whether an adjustment is offered, whether Save is enabled — and it
// is the engine's own `CENT_EPSILON`, re-exported here under the name this
// flow talks in.
export const SETTLED_EPSILON = CENT_EPSILON;

/** Does this transaction move money on this account at all? */
export function isAccountTx(tx, accountId) {
  return Math.abs(txAccountDelta(tx, accountId)) > 0;
}

/**
 * Split an account's transactions at the reconcile date into what has already
 * cleared and what is still outstanding.
 *
 * `clearedBaseline` is seeded with the account's opening balance, because a
 * statement states a full balance rather than a sum of movements — without
 * the seed, the gap on a first reconcile is exactly `initialBalance`.
 *
 * Future-dated rows are excluded: they are not on the statement being
 * reconciled. `uncleared` comes back newest-first, the order the dialog lists.
 */
export function splitByCleared(account, transactions, accountId, recDate) {
  let clearedBaseline = account?.initialBalance ?? 0;
  const uncleared = [];
  const undated = [];
  for (const tx of transactions || []) {
    if (!isAccountTx(tx, accountId)) continue;
    const d = tx.date || '';
    if (!d) { undated.push(tx); continue; }
    if (d > recDate) continue;
    const delta = txAccountDelta(tx, accountId);
    if (tx.cleared) clearedBaseline += delta;
    else uncleared.push({ tx, delta });
  }
  uncleared.sort((a, b) => (b.tx.date || '').localeCompare(a.tx.date || ''));
  return { clearedBaseline, uncleared, undated, recDate };
}

/**
 * What the dialog's totals block shows: the movement the user just ticked,
 * the reconciled total, and the distance left to the statement.
 *
 * `target` may be null (nothing entered yet) — then there is no gap to show
 * and `balanced` is false, which is what keeps Save from posting a blind
 * adjustment.
 *
 * @param {{ clearedBaseline?: number, selectedDeltas?: Array<number | undefined>, target?: number | null }} [opts]
 */
export function reconcileTotals({ clearedBaseline = 0, selectedDeltas = [], target = null } = {}) {
  let newly = 0;
  for (const d of selectedDeltas) if (typeof d === 'number' && Number.isFinite(d)) newly += d;
  const total = clearedBaseline + newly;
  if (target === null || target === undefined || !Number.isFinite(target)) {
    return { newly, total, gap: null, balanced: false };
  }
  const gap = target - total;
  return { newly, total, gap, balanced: Math.abs(gap) < SETTLED_EPSILON };
}

/**
 * The transaction list to persist: existing rows with the ticked ones marked
 * cleared, then the rows added during the session (also honouring the ticks),
 * then any adjustment.
 *
 * Rows are replaced, never mutated — `computeAccountBalances` memoizes on
 * array identity, so editing in place would leave a stale cached balance.
 *
 * @param {{ transactions?: any[], newlyAdded?: any[], selectedIds?: Set<string> | string[], adjustmentTx?: any, linkKeys?: Map<string, string> | null }} [opts]
 */
export function applyReconcile({
  transactions = [], newlyAdded = [], selectedIds, adjustmentTx = null, linkKeys = null,
} = {}) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  // `linkKeys` (txId → from_budget): existing rows the user chose to link to
  // a scheduled occurrence instead of posting a second copy of it.
  const links = linkKeys instanceof Map ? linkKeys : new Map();
  const mark = (tx) => {
    let out = tx;
    if (links.has(tx.id)) out = { ...out, from_budget: links.get(tx.id) };
    if (selected.has(tx.id)) {
      // Ticking a row says the statement shows it, so a scheduled row is now
      // posted. Leaving `status: 'scheduled'` made it cleared here yet absent
      // from the Today lens, which reads status (isPostedTx), not `cleared`.
      const { status, ...rest } = out;
      out = { ...(status === 'scheduled' ? rest : out), cleared: true };
    }
    return out;
  };
  const next = [];
  for (const tx of transactions) next.push(mark(tx));
  for (const tx of newlyAdded) next.push(mark(tx));
  if (adjustmentTx) next.push(adjustmentTx);
  return next;
}

// ─── Scheduled rows ──────────────────────────────────────────────────────

/**
 * The scheduled forecast rows to list on this account: not already posted,
 * tombstoned or added this session (`takenKeys`), and touching the account.
 *
 * A planned account_transfer has no `account` (scheduledForecastRow keys it by
 * from/to, matching a real account_transfer), so it is listed on both accounts
 * it moves money between. Fills never are: they carry no account, and an
 * allocation fill counted against a bank statement would break the
 * cleared-balance comparison.
 *
 * A loan payment's forecast legs (principal, interest, fee) are one entry: the
 * first leg's fields with `legs` holding every leg not yet taken, listed on
 * each account a leg moves (the paying account and the loan). Post writes the
 * legs together (`txsFromScheduledRow`), so the payment is never half posted
 * from here.
 */
export function scheduledRowsForAccount(forecasts, accountId, takenKeys) {
  /** @type {any[]} */
  const out = [];
  /** @type {Map<string, any>} occurrence → its entry */
  const loans = new Map();
  for (const f of forecasts || []) {
    if (takenKeys.has(forecastKey(f))) continue;
    if (f.forecast_loan_leg) {
      // One entry per loan payment: its legs are posted together, each under
      // its own key (see scheduledLoanEntry).
      const occ = `${f.forecast_budget_item_id}:${f.forecast_month_key}`;
      const entry = loans.get(occ);
      if (entry) entry.legs.push(f);
      else { const e = { ...f, legs: [f] }; loans.set(occ, e); out.push(e); }
      continue;
    }
    if (f.account === accountId
      || (f.type === 'account_transfer' && (f.from_account === accountId || f.to_account === accountId))) out.push(f);
  }
  return out.filter(f => !f.legs || f.legs.some((/** @type {any} */ leg) => isAccountTx(leg, accountId)));
}

/**
 * The `from_budget` key a scheduled forecast row posts under: the engine's
 * `forecastKey`, so a loan payment's interest and fee legs keep their
 * `:interest` / `:fee` keys. Composing `${item}:${month}` here posted an
 * interest leg under the principal's key, and the scheduler then took the
 * occurrence as paid and never posted the principal.
 */
export function scheduledRowKey(f) {
  return forecastKey(f);
}

/**
 * The account-side amount of a due-list entry: a loan payment's legs summed
 * (all of it on the paying account, the principal on the loan), otherwise the
 * row's own `txAccountDelta`.
 * @param {any} f
 * @param {string} accountId
 * @returns {number}
 */
export function scheduledRowDelta(f, accountId) {
  if (!Array.isArray(f.legs)) return txAccountDelta(f, accountId);
  let total = 0;
  for (const leg of f.legs) total += txAccountDelta(leg, accountId);
  return round2(total);
}

/**
 * The real transactions Post writes for a due-list entry: one row, or for a
 * loan payment every leg, each under its own key (`scheduledRowKey`) and on
 * its own accounts (the principal from the paying account into the loan, the
 * interest and fee as expenses on the paying account), whichever account is
 * being reconciled.
 * @param {any} f
 * @param {string} accountId
 * @param {() => string} newId
 * @returns {any[]}
 */
export function txsFromScheduledRow(f, accountId, newId) {
  if (!Array.isArray(f.legs)) return [txFromScheduledRow(f, accountId, newId())];
  return f.legs.map((/** @type {any} */ leg) => {
    const base = { id: newId(), date: leg.date, amount: Math.abs(leg.amount), payee: leg.payee || '', from_budget: scheduledRowKey(leg) };
    if (leg.type === 'debt_payment') {
      return { ...base, type: 'debt_payment', from_account: leg.from_account, to_account: leg.to_account, envelope_id: leg.envelope_id || null };
    }
    return { ...base, type: leg.type, account: leg.account, envelope_id: leg.type === 'expense' ? (leg.envelope_id || null) : null };
  });
}

/**
 * The real transaction Post writes for a scheduled row. A transfer is
 * identified by from/to and has no `account`, exactly like a real
 * account_transfer (txAccountDelta); anything else posts on this account.
 * `amount` is a positive magnitude either way (the sign convention).
 */
export function txFromScheduledRow(f, accountId, id) {
  const base = {
    id,
    date: f.date,
    amount: Math.abs(f.amount),
    payee: f.payee || '',
    from_budget: scheduledRowKey(f),
  };
  if (f.type === 'account_transfer') {
    return {
      ...base, type: 'account_transfer',
      from_account: f.from_account, to_account: f.to_account, envelope_id: null,
    };
  }
  return {
    ...base, type: f.type, account: accountId,
    envelope_id: f.type === 'expense' ? (f.envelope_id || null) : null,
  };
}

/**
 * Untagged transactions that look like the payment for this scheduled row:
 * same kind and route (a transfer's from/to; a bill's account and envelope;
 * income's account), and settling it by the link matcher's own rule
 * (`paymentSettles`: amount within a cent, date within LINK_DAY_WINDOW).
 *
 * Post checks this first. A transfer or bill the user already recorded by
 * hand carries no `from_budget`, so without the check Post adds a second row
 * AND settles the key, and the duplicate is then the only thing marked as
 * the payment.
 */
export function untaggedMatchesForScheduledRow(f, transactions, accountId) {
  const amount = Math.abs(Number(f.amount) || 0);
  const occ = { date: f.date, amount };
  return (transactions || []).filter((tx) => {
    if (!tx || tx.is_forecast) return false;
    if (typeof tx.from_budget === 'string' && tx.from_budget) return false;
    if (tx.type !== f.type) return false;
    if (f.type === 'account_transfer') {
      if (tx.from_account !== f.from_account || tx.to_account !== f.to_account) return false;
    } else {
      if (tx.account !== accountId) return false;
      if (f.type === 'expense' && f.envelope_id) {
        const splits = Array.isArray(tx.envelope_splits) ? tx.envelope_splits : [];
        const inEnvelope = tx.envelope_id === f.envelope_id
          || splits.some(sp => sp && sp.envelope_id === f.envelope_id);
        if (!inEnvelope) return false;
      }
    }
    return paymentSettles({ date: String(tx.date || '').slice(0, 10), amount: txAbsAmount(tx) }, occ);
  });
}

// ─── Manual rows ─────────────────────────────────────────────────────────

/**
 * The transaction the add panel writes. `type` is the panel's choice:
 * 'expense' | 'income' | 'transfer_out' | 'transfer_in' | 'investment_out' |
 * 'investment_in'. Out means money leaving the reconciled account (a buy, for
 * an investment); in means money arriving (a sell). Returns null when a
 * transfer or investment names no other account.
 */
export function buildManualTx({ type, accountId, otherAccountId, date, payee, amount, note = null, envelopeId = null, id }) {
  const isTransfer = type === 'transfer_out' || type === 'transfer_in';
  const isInvestment = type === 'investment_out' || type === 'investment_in';
  if (isTransfer || isInvestment) {
    if (!otherAccountId) return null;
    const outgoing = type === 'transfer_out' || type === 'investment_out';
    const from_account = outgoing ? accountId : otherAccountId;
    const to_account = outgoing ? otherAccountId : accountId;
    return isInvestment
      ? { id, date, payee, amount, note, type: 'investment_transfer', direction: outgoing ? 'buy' : 'sell', from_account, to_account }
      : { id, date, payee, amount, note, type: 'account_transfer', from_account, to_account };
  }
  return { id, date, payee, amount, type, note, envelope_id: envelopeId || null, account: accountId };
}

/**
 * Accounts the add panel offers as the other side of a transfer: active,
 * not this account, not an asset. `keepId` is added even when it fails that
 * test, so editing a planned transfer to an archived account or an asset
 * keeps its real counterpart instead of silently switching to the first
 * account in the list. The kept one is flagged `archived`/`asset`.
 */
export function transferCounterpartOptions(accounts, accountId, keepId = null) {
  const out = [];
  for (const a of accounts || []) {
    if (!a || !a.id || a.id === accountId) continue;
    const offered = !a.archived && a.type !== 'asset';
    if (offered || a.id === keepId) {
      out.push({ id: a.id, name: a.name, archived: !!a.archived, asset: a.type === 'asset', kept: !offered });
    }
  }
  return out;
}

/**
 * Stamp the reconciled account with the date and statement balance it was
 * reconciled to. The stamp is what later reconciles use as their earliest
 * allowed date, so it records the statement figure, not the computed total.
 */
export function markReconciled(accounts, accountId, recDate, statementBalance, transactions = null, stamp = null) {
  return (accounts || []).map((a) => {
    if (a.id !== accountId) return a;
    const next = { ...a, lastReconciledAt: recDate, lastReconciledBalance: statementBalance };
    // When the reconciliation was done (an ISO timestamp), so a later drift
    // can name the changes made after it (reconciledDriftChanges).
    if (stamp) next.lastReconciledStamp = stamp;
    // The ledger side the user agreed to: equal to the statement unless the
    // adjustment was declined. Drift is measured from this (findReconciledDrift).
    if (transactions) {
      const ledger = reconciledLedgerBalance(next, transactions);
      if (ledger !== null) next.lastReconciledLedger = ledger;
    }
    return next;
  });
}
