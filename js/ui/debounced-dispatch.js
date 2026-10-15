// js/ui/debounced-dispatch.js — coalesce live edits (sliders, toggles) into one
// command per id, sent after a quiet window.
//
// A page keeps a local overlay of `pending(id)` over the state it renders, so
// the control follows the user's hand while nothing is saved yet. Fields merge
// per id (the last value per key wins) and go out as one `{ id, fields }`.
// `onSettled(id, result)` runs after each dispatch lands; on a failure the page
// drops that id's overlay, repaints from state and toasts.
//
// The window is unsaved work, so the helper registers `hasPending` with the
// unload guard: closing the tab inside it prompts. A budget switch must not let
// the old budget's edit fire into the new one, so work started for one folder
// is dropped when `currentFolder()` has changed (the session's own dispatch-time
// binding is the second line of defence), and `pending()` never shows it over
// another budget's item: ids repeat across budgets. The owner also calls
// `dropAll()` on a switch, which covers a reload that keeps the folder object. A dispatch already sent cannot be
// recalled, but its `onSettled` is suppressed once its budget is no longer the
// current one (or after `dropAll`), so a stale failure never toasts in the new
// budget.
//
// The helper registers with the guard only while it has queued or in-flight work
// and unregisters when idle, so an idle helper costs the guard nothing. Even so,
// a page creates ONE helper at module scope, not one per render, and its
// `onSettled` calls the current render function rather than a captured one.
// `dispose()` drops everything and unregisters, for a page that really is torn
// down.

import { registerPending } from '../state/unload-guard.js';

/**
 * @param {object} opts
 * @param {{ dispatch: (name: string, input: any) => Promise<any> }} opts.session
 * @param {string} opts.command  e.g. 'budgetItem.update'
 * @param {number} [opts.delay]  quiet window in ms
 * @param {(id: string, result: any) => void} [opts.onSettled]
 * @param {() => any} opts.currentFolder  e.g. () => state.budgetFolder
 */
export function createDebouncedDispatch({ session, command, delay = 400, onSettled, currentFolder }) {
  /** Edits waiting for their timer: id -> { fields, folder, timer }. */
  const queued = new Map();
  /** Dispatches sent and not yet settled. */
  const inflight = new Set();
  let unregister = null;
  let failureVersion = 0;

  // Registered while any work is outstanding, unregistered when idle.
  function sync() {
    const busy = queued.size > 0 || inflight.size > 0;
    if (busy && !unregister) unregister = registerPending(api.hasPending);
    else if (!busy && unregister) { unregister(); unregister = null; }
  }

  function drop(id) {
    const entry = queued.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    queued.delete(id);
  }

  function fire(id) {
    const entry = queued.get(id);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    queued.delete(id);
    if (entry.folder !== currentFolder()) { sync(); return Promise.resolve(); }
    const job = { id, fields: entry.fields, folder: entry.folder, dropped: false, promise: null };
    // In flight before the dispatch is called: a dispatch that throws
    // synchronously settles inside the call below, and must find the job here
    // to take it out again.
    inflight.add(job);
    sync();
    job.promise = (async () => {
      let result;
      try {
        result = await session.dispatch(command, { id, fields: entry.fields });
      } catch (err) {
        // A command failure is a value; a throw is a programmer error. Either
        // way the page must repaint from state, so report it as a failure.
        result = { ok: false, error: { code: 'dispatch_threw', params: { message: err?.message || String(err) } } };
      }
      inflight.delete(job);
      sync();
      if (job.dropped || job.folder !== currentFolder()) return;
      if (!result.ok) failureVersion++;
      onSettled?.(id, result);
    })();
    return job.promise;
  }

  const api = {
    set(id, fields) {
      const folder = currentFolder();
      const prior = queued.get(id);
      // Fields queued under another budget are not this budget's edit.
      if (prior && prior.folder !== folder) drop(id);
      const entry = queued.get(id) || { fields: {}, folder, timer: null };
      entry.fields = { ...entry.fields, ...fields };
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { fire(id); }, delay);
      queued.set(id, entry);
      sync();
    },

    /** Forget this id's queued fields and stop its timer (a page calls it on failure). */
    drop(id) {
      drop(id);
      sync();
    },

    /** The fields queued or in flight for `id` in the current budget, or null. */
    pending(id) {
      const folder = currentFolder();
      let merged = null;
      for (const job of inflight) if (job.id === id && job.folder === folder) merged = { ...merged, ...job.fields };
      const entry = queued.get(id);
      if (entry && entry.folder === folder) merged = { ...merged, ...entry.fields };
      return merged;
    },

    /** Dispatch everything now; resolves when nothing is queued or in flight. */
    async flush() {
      const started = failureVersion;
      while (queued.size > 0 || inflight.size > 0) {
        for (const id of [...queued.keys()]) fire(id);
        await Promise.all([...inflight].map((job) => job.promise));
      }
      return failureVersion === started;
    },

    hasPending() {
      return queued.size > 0 || inflight.size > 0;
    },

    dropAll() {
      for (const id of [...queued.keys()]) drop(id);
      for (const job of inflight) job.dropped = true;
      inflight.clear();
      sync();
    },

    /** Drop everything and unregister from the unload guard. */
    dispose() {
      api.dropAll();
    },
  };

  return api;
}
