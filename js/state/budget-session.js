// js/state/budget-session.js — which budget load owns app state right now.
//
// Every call to loadBudgetIntoState starts a new session. Work that began
// under an older session — a load still awaiting its reads, an Undo toast
// offered before the switch — checks its session before it publishes into
// `state` or writes through `state.budgetFolder`, because by then both belong
// to a different budget. The handle alone cannot tell: the guest budget reuses
// one handle object across resets, and a reopened budget is the same budget
// with possibly different data.

let session = 0;
/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Start a new session and return its id. The budget loader calls this, and so
 * does the guest picker just before it replaces guest memory (the guest budget
 * keeps one folder object, so the old budget's work must end before then).
 * Listeners (onBudgetSessionChange) run before it returns.
 */
export function beginBudgetSession() {
  session += 1;
  for (const fn of [...listeners]) {
    try { fn(); } catch (err) { console.error('budget session listener failed:', err); }
  }
  return session;
}

/**
 * Run `fn` whenever a new session starts, for work that belongs to the old
 * budget and must end with it (pending live edits, page-local drafts).
 * Returns an unsubscribe function.
 * @param {() => void} fn
 */
export function onBudgetSessionChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The id of the session that currently owns app state. */
export function currentBudgetSession() {
  return session;
}

// The session a load or the setup wizard holds, or 0. While held, `state` is
// cleared or stale under the new budget's handle, so the browser session
// refuses every write (js/session/browser-session.js, `isLoading`). Tied to a
// session id, so a superseded load cannot release a newer one's hold, and a
// new session ends an old hold without anyone releasing it.
let held = 0;

/**
 * Hold the current session until releaseBudget(id): the loader from the start
 * of its session until it publishes the collections (or fails), the setup
 * wizard until it publishes the new budget. Returns the session id.
 */
export function holdBudget() {
  held = session;
  return session;
}

/** End the hold on session `id`; a no-op once another session holds or owns state. */
export function releaseBudget(id) {
  if (held === id) held = 0;
}

/** Whether a load or the setup wizard holds the budget that owns app state. */
export function budgetHeld() {
  return held !== 0 && held === session;
}
