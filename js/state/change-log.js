// js/state/change-log.js — an audit trail of changes to recorded money.
//
// Transactions are edited in place and deleted outright, so once a row is
// changed nothing says what it was. Bookkeeping keeps that trail: a posted
// entry is corrected visibly, not silently. This records, for every
// transaction write the session commits, each row whose money changed
// (amount, date, account, envelope, type, status, cleared, …) and each row
// deleted, with the row before and after. Additions are not logged: a new
// row is its own record. Payee, note and flag edits are not either: they move
// no money, and a payee merge would flood the log.
//
// Stored in `meta.change_log`, newest last, capped at CHANGE_LOG_CAP entries.
// It is a trail for the owner to read (Settings → Clean-up), not a ledger to
// replay: nothing computes from it.
//
// Pure: no DOM, no state import.

export const CHANGE_LOG_CAP = 1000;

// The fields whose change moves money or changes which money a row is.
const MONEY_FIELDS = [
  'type', 'amount', 'date', 'status', 'account', 'from_account', 'to_account',
  'envelope_id', 'envelope_splits', 'from_envelope_id', 'to_envelope_id',
  'target', 'target_id', 'lines', 'direction', 'units', 'fee', 'symbol', 'cleared',
];

// A missing field, null and false read the same to every reader of a row.
const norm = (v) => (v === undefined || v === false ? null : v);

/** Structural equality for the plain JSON values a row holds. */
function same(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
  return JSON.stringify(x) === JSON.stringify(y);
}

// The write boundary stores a type-signed row's amount as a magnitude
// (normalizeTxAmount), so a legacy signed amount turning positive on its
// first save is not an edit. Only `adjustment` keeps its sign.
function sameAmount(before, after) {
  const a = Number(before.amount);
  const b = Number(after.amount);
  if (after.type === 'adjustment' || before.type === 'adjustment') return same(before.amount, after.amount);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return same(before.amount, after.amount);
  return Math.abs(a) === Math.abs(b);
}

/**
 * @typedef {{ at: string, op: 'edit' | 'delete', id: string, fields: string[], before: any, after?: any }} ChangeLogEntry
 */

/**
 * The change-log entries one transaction write produces.
 *
 * @param {any[]} prev   the transactions before the write
 * @param {any[]} next   the transactions the write stores
 * @param {string} at    ISO timestamp of the write
 * @returns {ChangeLogEntry[]}
 */
export function diffTransactionWrite(prev, next, at) {
  /** @type {Map<string, any>} */
  const nextById = new Map();
  for (const tx of next || []) if (tx && typeof tx.id === 'string') nextById.set(tx.id, tx);
  /** @type {ChangeLogEntry[]} */
  const out = [];
  for (const before of prev || []) {
    if (!before || typeof before.id !== 'string' || before.is_forecast) continue;
    const after = nextById.get(before.id);
    if (!after) {
      out.push({ at, op: 'delete', id: before.id, fields: [], before });
      continue;
    }
    if (after === before) continue;
    const fields = MONEY_FIELDS.filter(f => (f === 'amount' ? !sameAmount(before, after) : !same(before[f], after[f])));
    if (fields.length) out.push({ at, op: 'edit', id: before.id, fields, before, after });
  }
  return out;
}

/**
 * The stored log, oldest first; [] when there is none or it is malformed.
 * @param {any} meta
 * @returns {ChangeLogEntry[]}
 */
export function getChangeLog(meta) {
  return Array.isArray(meta?.change_log) ? meta.change_log : [];
}

/**
 * `meta` with `entries` appended to its change log, capped to the newest
 * CHANGE_LOG_CAP. Returns a new object; `meta` is not modified.
 * @param {any} meta
 * @param {ChangeLogEntry[]} entries
 */
export function appendChangeLog(meta, entries) {
  const log = [...getChangeLog(meta), ...(entries || [])];
  return { ...(meta || {}), change_log: log.length > CHANGE_LOG_CAP ? log.slice(log.length - CHANGE_LOG_CAP) : log };
}
