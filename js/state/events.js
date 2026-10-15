// js/state/events.js — Tiny pub/sub for state changes. The codebase
// still mutates `state` directly from many call sites; this module is
// the bridge that lets newer code subscribe to changes incrementally
// without forcing a wholesale immutable-update refactor.
//
// Convention: callers that mutate state should follow the mutation with
// a notifyStateChanged(...keys) so subscribers can react. Callers that
// don't notify won't break anything — subscribers just won't see the
// change until the next notified mutation.

const subscribers = new Set();

/**
 * Register a listener invoked on every notifyStateChanged call.
 * @param {(keys: string[]) => void} listener
 * @returns {() => void} unsubscribe function
 */
export function subscribeState(listener) {
  if (typeof listener !== 'function') return () => {};
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

/**
 * Notify subscribers that one or more top-level state keys changed.
 * Errors thrown by listeners are isolated — one bad listener cannot
 * suppress notifications to the rest.
 *
 * @param {...string} keys
 */
export function notifyStateChanged(...keys) {
  if (subscribers.size === 0) return;
  const list = Array.from(subscribers);
  for (const fn of list) {
    try { fn(keys); }
    catch (err) { console.error('state listener error:', err); }
  }
}

// Test-only: drop all listeners. Not exported as part of the regular
// API surface — vitest needs it to keep tests isolated.
export function _resetSubscribersForTests() {
  subscribers.clear();
}
