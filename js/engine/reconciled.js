// js/engine/reconciled.js — which rows a bank reconciliation vouches for, and
// whether the ledger still agrees with it.
//
// Reconciling an account (js/reconcile.js) ticks the rows the statement shows
// as `cleared`, posts an adjustment for any gap, and records
// `lastReconciledAt` / `lastReconciledBalance` on the account. From then on
// the opening balance plus every cleared row dated on or before that date is
// the balance the user agreed with the bank. Editing, deleting or un-clearing
// one of those rows silently moves it: bookkeeping treats a reconciled entry
// as settled, so the app asks before such a change (js/ui/reconciled-guard.js)
// and the status badge reports an account whose cleared rows no longer add up
// (`runInvariantCheck`, category `reconciled`).
//
// `lastReconciledLedger` is the ledger side at the moment of reconciling. It
// equals the statement balance unless the user declined the adjustment;
// accounts reconciled before it was recorded are compared with the statement
// balance instead.
//
// Pure functions. No DOM, no I/O.

import { txAccountDelta } from './tx-amounts.js';
import { CENT_EPSILON } from './_constants.js';
import { round2 } from '../utils.js';

/**
 * @typedef {{
 *   id: string,
 *   archived?: boolean,
 *   initialBalance?: number,
 *   lastReconciledAt?: string | null,
 *   lastReconciledBalance?: number | null,
 *   lastReconciledLedger?: number | null,
 * }} ReconcilableAccount
 */

/** 'YYYY-MM-DD' of a row, or '' when it has none. */
function dayOf(tx) {
  return typeof tx?.date === 'string' ? tx.date.slice(0, 10) : '';
}

/**
 * The account's reconcile date, or null when it has never been reconciled.
 * @param {ReconcilableAccount | null | undefined} account
 * @returns {string | null}
 */
function reconciledAt(account) {
  const at = account?.lastReconciledAt;
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null;
}

/**
 * What one row contributes to an account's reconciled balance: its delta on
 * that account when it is cleared and dated on or before `at`, else 0.
 * @param {any} tx
 * @param {string} accountId
 * @param {string} at
 * @returns {number}
 */
function reconciledDelta(tx, accountId, at) {
  if (!tx || !tx.cleared) return 0;
  const day = dayOf(tx);
  if (!day || day > at) return 0;
  return txAccountDelta(tx, accountId);
}

/**
 * Whether a bank reconciliation vouches for this row: it is cleared, dated on
 * or before the reconcile date of an account it moves money on.
 *
 * @param {any} tx
 * @param {ReconcilableAccount[]} accounts
 * @returns {boolean}
 */
export function isReconciledRow(tx, accounts) {
  if (!tx || !tx.cleared) return false;
  for (const a of accounts || []) {
    const at = reconciledAt(a);
    if (at && reconciledDelta(tx, a.id, at) !== 0) return true;
  }
  return false;
}

/**
 * The balance the last reconciliation agreed: the opening balance plus every
 * cleared row on the account dated on or before `lastReconciledAt`. Null for
 * an account that was never reconciled.
 *
 * @param {ReconcilableAccount} account
 * @param {any[]} transactions
 * @returns {number | null}
 */
export function reconciledLedgerBalance(account, transactions) {
  const at = reconciledAt(account);
  if (!at) return null;
  let total = Number(account.initialBalance) || 0;
  for (const tx of transactions || []) total += reconciledDelta(tx, account.id, at);
  return round2(total);
}

/**
 * How replacing the rows `before` with the rows `after` moves each reconciled
 * balance. Pass the old versions of the rows a write touches and their new
 * versions (none for a delete). Only accounts that actually move are listed,
 * so an empty result means the write leaves every reconciliation intact.
 *
 * @param {ReconcilableAccount[]} accounts
 * @param {any[]} before
 * @param {any[]} after
 * @returns {Array<{ accountId: string, shift: number }>}
 */
export function reconciledBalanceShift(accounts, before, after) {
  /** @type {Array<{ accountId: string, shift: number }>} */
  const out = [];
  for (const a of accounts || []) {
    const at = reconciledAt(a);
    if (!at) continue;
    let shift = 0;
    for (const tx of after || []) shift += reconciledDelta(tx, a.id, at);
    for (const tx of before || []) shift -= reconciledDelta(tx, a.id, at);
    if (Math.abs(shift) >= CENT_EPSILON) out.push({ accountId: a.id, shift: round2(shift) });
  }
  return out;
}

/**
 * Accounts whose cleared rows no longer add up to what was reconciled. `gap`
 * is actual − expected: the amount by which later edits moved a balance the
 * user had agreed with the bank. Archived accounts are skipped.
 *
 * @param {ReconcilableAccount[]} accounts
 * @param {any[]} transactions
 * @returns {Array<{ accountId: string, reconciledAt: string, expected: number, actual: number, gap: number }>}
 */
export function findReconciledDrift(accounts, transactions) {
  const out = [];
  for (const a of accounts || []) {
    if (!a || a.archived) continue;
    const at = reconciledAt(a);
    if (!at) continue;
    const ledger = Number.isFinite(a.lastReconciledLedger) ? a.lastReconciledLedger : a.lastReconciledBalance;
    if (typeof ledger !== 'number' || !Number.isFinite(ledger)) continue;
    const actual = reconciledLedgerBalance(a, transactions);
    if (actual === null) continue;
    const gap = round2(actual - ledger);
    if (Math.abs(gap) >= CENT_EPSILON) {
      out.push({ accountId: a.id, reconciledAt: at, expected: round2(ledger), actual, gap });
    }
  }
  return out;
}

/**
 * @typedef {{
 *   id: string,
 *   kind: 'added' | 'edited' | 'cleared' | 'uncleared' | 'deleted',
 *   at: string | null,
 *   date: string,
 *   payee: string,
 *   shift: number,
 *   exists: boolean,
 * }} DriftChange
 */

/**
 * The changes that moved an account's reconciled balance after it was
 * reconciled: rows on the account, dated on or before the reconcile date,
 * whose cleared contribution was changed (edited, deleted, cleared or
 * un-cleared, from `meta.change_log`) or that were added cleared since.
 *
 * When the reconciliation was done is `lastReconciledStamp` (written by
 * account.reconcile since 2026-10-05). An account reconciled before then has
 * no such time: `timingKnown` is false and only the changes to rows that were
 * already cleared in the reconciled period are listed (an edit, delete or
 * un-clear of a reconciled row); a row added or cleared later cannot be told
 * from one the reconciliation itself ticked. Rows changed beyond the change
 * log's cap are not seen either way. Oldest first, one entry per row (its
 * shifts summed, its latest change's kind and time).
 *
 * @param {(ReconcilableAccount & { lastReconciledStamp?: string | null }) | null | undefined} account
 * @param {any[]} transactions
 * @param {any[]} [changeLog]  `meta.change_log`
 * @returns {{ timingKnown: boolean, changes: DriftChange[] }}
 */
export function reconciledDriftChanges(account, transactions, changeLog = []) {
  const at = reconciledAt(account);
  const stamp = typeof account?.lastReconciledStamp === 'string' && account.lastReconciledStamp
    ? account.lastReconciledStamp : null;
  if (!at || !account) return { timingKnown: !!stamp, changes: [] };
  const id = account.id;
  /** @type {Map<string, DriftChange>} */
  const byRow = new Map();
  const current = new Map((transactions || []).filter(tx => tx && typeof tx.id === 'string').map(tx => [tx.id, tx]));
  /** @param {DriftChange} c */
  const note = (c) => {
    const prev = byRow.get(c.id);
    if (prev) { c.shift = round2(prev.shift + c.shift); byRow.delete(c.id); }
    byRow.set(c.id, c);
  };
  for (const e of Array.isArray(changeLog) ? changeLog : []) {
    if (!e || typeof e.id !== 'string' || !e.before || (e.op !== 'edit' && e.op !== 'delete')) continue;
    if (stamp && !(typeof e.at === 'string' && e.at > stamp)) continue;
    const b = reconciledDelta(e.before, id, at);
    const after = e.op === 'delete' ? null : e.after;
    const a = after ? reconciledDelta(after, id, at) : 0;
    if (Math.abs(a - b) < CENT_EPSILON) continue;
    // Without the reconcile's time, only a change to a row it vouched for.
    if (!stamp && Math.abs(b) < CENT_EPSILON) continue;
    const row = after || e.before;
    /** @type {DriftChange['kind']} */
    const kind = !after ? 'deleted'
      : e.before.cleared && !after.cleared ? 'uncleared'
        : !e.before.cleared && after.cleared ? 'cleared' : 'edited';
    note({
      id: e.id, kind, at: typeof e.at === 'string' ? e.at : null, date: dayOf(row),
      payee: String(row.payee || row.note || ''), shift: round2(a - b), exists: current.has(e.id),
    });
  }
  // A cleared row added after the reconcile, in its period: additions are
  // not in the change log, the row's own created_at says when.
  if (stamp) {
    for (const tx of current.values()) {
      if (byRow.has(tx.id)) continue;
      if (!(typeof tx.created_at === 'string' && tx.created_at > stamp)) continue;
      const d = reconciledDelta(tx, id, at);
      if (Math.abs(d) < CENT_EPSILON) continue;
      note({ id: tx.id, kind: 'added', at: tx.created_at, date: dayOf(tx), payee: String(tx.payee || tx.note || ''), shift: round2(d), exists: true });
    }
  }
  const changes = [...byRow.values()].sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')));
  return { timingKnown: !!stamp, changes };
}
