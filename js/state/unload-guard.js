// js/state/unload-guard.js — warn before the page closes with a save in flight.
//
// Every write is sent the moment it is made. The session's dispatch awaits its
// write before it publishes or returns, but the page stays usable while the
// PUT (or the folder write) is in flight, and the storage facade and the meta
// queue can hold pending writes. Closing or reloading the tab in that window
// cancels the request and loses the edit with no sign of it; the cloud e2e
// golden path hit exactly this (BACKLOG 2026-09-29).
//
// A request that outlives the page (`fetch(..., { keepalive: true })`,
// `sendBeacon`) is capped at 64 KB by browsers, and a budget's transactions
// blob is megabytes, so the write cannot be finished on the way out. What can
// be done is to ask: while anything is pending, `beforeunload` shows the
// browser's own "Leave site? Changes may not be saved" prompt. When nothing
// is pending it does nothing, so a normal close or reload is never
// interrupted.

import { hasPendingWrites } from '../storage/index.js';
import { metaWritesPending } from './meta-queue.js';

/** @type {Set<() => boolean>} */
const pendingSources = new Set();

/**
 * Register a source of unsaved work that the storage facade cannot see, such as
 * a debounce timer that has not dispatched yet. While `fn()` is true, closing
 * the page prompts.
 * @param {() => boolean} fn
 * @returns {() => void} unregister
 */
export function registerPending(fn) {
  pendingSources.add(fn);
  return () => { pendingSources.delete(fn); };
}

/** How many sources are registered. For tests: proves a source unregisters when idle. */
export function pendingSourceCount() {
  return pendingSources.size;
}

/** True when closing the page now could lose a write. */
export function hasUnsavedWrites() {
  if (hasPendingWrites() || metaWritesPending()) return true;
  for (const fn of pendingSources) if (fn()) return true;
  return false;
}

/**
 * The `beforeunload` handler. Exported for tests.
 * @param {BeforeUnloadEvent} event
 * @param {() => boolean} [pending]
 */
export function onBeforeUnload(event, pending = hasUnsavedWrites) {
  if (!pending()) return undefined;
  event.preventDefault();
  // Older browsers show the prompt only when returnValue is set.
  event.returnValue = '';
  return '';
}

/** Install once, at startup. */
export function installUnloadGuard(target = window) {
  target.addEventListener('beforeunload', (e) => onBeforeUnload(e));
}
