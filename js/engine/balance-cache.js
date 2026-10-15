/**
 * balance-cache.js — identity-based memoization for the two hot balance
 * functions in engine.js (`computeEnvelopeBalances`, `computeAccountBalances`).
 *
 * Strategy: memoize by reference identity of the `transactions` array (and,
 * where present, the `accounts` array) plus a serialized `opts` key. Any tx
 * write replaces `state.transactions` with a new array (see
 * the session's commit in `js/session/browser-session.js`), and `state.accounts` is always
 * reassigned, never mutated in place — so identity changes invalidate
 * automatically with no explicit invalidation API.
 *
 * Returned Maps are locked (`set`/`delete`/`clear` throw) to surface
 * accidental mutation immediately. `Object.freeze` does NOT prevent Map
 * mutation, so we override the methods on the cached instance.
 */

const txMemo = new WeakMap(); // txs array -> Map<innerKey, lockedResult>
const accountsIds = new WeakMap(); // accounts array -> stable id
let nextAccountsId = 1;

export const _stats = { hits: 0, misses: 0, walkMs: 0 };

function accountsKey(accounts) {
  if (!accounts || typeof accounts !== 'object') return 'a:none';
  let id = accountsIds.get(accounts);
  if (id === undefined) {
    id = nextAccountsId++;
    accountsIds.set(accounts, id);
  }
  return 'a:' + id;
}

function optsKey(opts) {
  if (!opts) return 'o:{}';
  // opts shape: { onlyPosted?: boolean, asOf?: Date | string | null }.
  // Date stringifies to a stable ISO string via toJSON.
  return 'o:' + JSON.stringify(opts);
}

function lockMap(m) {
  const err = () => { throw new Error('balance Map is cached/read-only'); };
  m.set = err;
  m.delete = err;
  m.clear = err;
  return m;
}

/**
 * Wrap a balance function with identity-based memoization.
 *
 * @param {Function} fn               underlying compute function
 * @param {number}   txArgIndex       index of the transactions array in args
 * @param {number|null} accountsArgIndex  index of the accounts array, or null
 * @param {number}   optsArgIndex     index of the opts object
 * @param {string}   [namespace]      key prefix for a wrapped function whose
 *   (accounts, opts) could otherwise collide with another's in the shared
 *   per-transactions cache — `computeAccountBalancesAtDates` takes the same
 *   accounts and an opts bag of the same shape as `computeAccountBalances`.
 *
 * A result that is a Map is locked read-only; so is an array of Maps (each
 * Map locked, the array frozen).
 */
export function memoize(fn, txArgIndex, accountsArgIndex, optsArgIndex, namespace = '') {
  return function memoized(...args) {
    const txs = args[txArgIndex];
    if (!txs || typeof txs !== 'object') {
      return fn.apply(this, args);
    }
    let inner = txMemo.get(txs);
    if (!inner) {
      inner = new Map();
      txMemo.set(txs, inner);
    }
    const accounts = accountsArgIndex == null ? null : args[accountsArgIndex];
    const opts     = args[optsArgIndex];
    const key = namespace + accountsKey(accounts) + '|' + optsKey(opts);
    if (inner.has(key)) {
      _stats.hits++;
      return inner.get(key);
    }
    _stats.misses++;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const result = fn.apply(this, args);
    if (t0) _stats.walkMs += performance.now() - t0;
    const locked = (result instanceof Map) ? lockMap(result)
      : Array.isArray(result) ? Object.freeze(result.map(r => (r instanceof Map ? lockMap(r) : r)))
      : result;
    inner.set(key, locked);
    return locked;
  };
}

/** Test-only: zero the stats counters. */
export function _resetStats() {
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.walkMs = 0;
}

// Ad-hoc browser-console profiling: read `__BUNVELOPE_BAL_STATS__` from the
// devtools console. Defined as a non-enumerable accessor rather than assigned
// as a property, so a debug handle does not sit in the production global
// namespace where `Object.keys(globalThis)` or a for-in can find it.
if (typeof globalThis !== 'undefined' && !('__BUNVELOPE_BAL_STATS__' in globalThis)) {
  Object.defineProperty(globalThis, '__BUNVELOPE_BAL_STATS__', {
    get: () => _stats,
    configurable: true,
    enumerable: false,
  });
}

// ─── listHoldings memoization ─────────────────────────────────────────────
//
// `listHoldings(transactions, holdingOverrides, manualRows)` is read at
// least once per render of the Investments page, the Accounts page, and
// twice on the Dashboard. All three arguments have stable identity across
// renders: `state.transactions` is reassigned only on tx writes, and
// `holdingOverrides` / `manualRows` come from a `state.meta.investments`
// object that `withInvestments` rebuilds on every meta write
// (js/state/investments.js). So identity-keyed caching mirrors the
// invalidation discipline of `computeAccountBalances`.

const holdingsTxMap = new WeakMap(); // txs -> WeakMap<overrides, WeakMap<manualRows, result>>
const HOLDINGS_EMPTY = Object.freeze({}); // stable key when caller passes nullish

export const _holdingsStats = { hits: 0, misses: 0 };

export function memoizeHoldings(fn) {
  return function memoizedHoldings(txs, overrides, manualRows) {
    if (!txs || typeof txs !== 'object') return fn(txs, overrides, manualRows);
    let l1 = holdingsTxMap.get(txs);
    if (!l1) { l1 = new WeakMap(); holdingsTxMap.set(txs, l1); }
    const ovKey = overrides && typeof overrides === 'object' ? overrides : HOLDINGS_EMPTY;
    const mrKey = manualRows && typeof manualRows === 'object' ? manualRows : HOLDINGS_EMPTY;
    let l2 = l1.get(ovKey);
    if (!l2) { l2 = new WeakMap(); l1.set(ovKey, l2); }
    if (l2.has(mrKey)) {
      _holdingsStats.hits++;
      return l2.get(mrKey);
    }
    _holdingsStats.misses++;
    const result = fn(txs, overrides, manualRows);
    l2.set(mrKey, result);
    return result;
  };
}

export function _resetHoldingsStats() {
  _holdingsStats.hits = 0;
  _holdingsStats.misses = 0;
}
