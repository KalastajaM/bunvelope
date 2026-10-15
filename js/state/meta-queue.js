// js/state/meta-queue.js — one serialised, budget-scoped queue for meta writes.
//
// Several writers save the whole meta object (the UI-state updateMeta writers,
// and the browser session's meta-primary commits through runExclusive).
// Unserialised, two in-flight writes race and the later one drops the earlier
// one's change, on disk and in memory. Each patch here runs against the meta
// the previous write produced, `state.meta` moves only after a write lands,
// and a patch queued for a budget the user has since switched away from is
// dropped instead of being written into the new one, even on the same folder.
// UI updates also refuse a load/wizard hold before queuing and before saving.

import { currentBudgetSession, budgetHeld } from './budget-session.js';

export class BudgetLoadingError extends Error {
  constructor() { super('The budget is still loading'); this.name = 'BudgetLoadingError'; this.code = 'budget_loading'; }
}

export class StaleBudgetError extends Error {
  constructor() { super('The budget changed before this write ran'); this.name = 'StaleBudgetError'; }
}

let pendingMeta = 0;

/**
 * Meta patches waiting in any queue or being written. A patch queued behind
 * another has not reached the storage adapter yet, so the adapter's own
 * pending check cannot see it; the unload guard asks both.
 */
export function metaWritesPending() {
  return pendingMeta > 0;
}

/**
 * `update` runs a patch and saves the result with `save`. `runExclusive` is
 * for a writer whose meta must land in the same write as other files (the
 * browser session's meta-primary commits): in the queue's order and with the
 * same folder checks, it hands `fn` the latest meta, then calls the `write`
 * that `fn` returns instead of `save`, and assigns `meta` once that lands.
 * @param {(folder: any, meta: object) => Promise<unknown>} save
 */
export function createMetaQueue(save) {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {{ budgetFolder: any, meta: object }} state
   * @param {(folder: any, owned: () => boolean) => Promise<T>} step
   * @returns {Promise<T>}
   */
  function enqueue(state, step) {
    const folder = state.budgetFolder;
    const session = currentBudgetSession();
    const owned = () => state.budgetFolder === folder && currentBudgetSession() === session;
    pendingMeta++;
    const run = chain.then(() => {
      if (!owned()) throw new StaleBudgetError();
      return step(folder, owned);
    });
    const done = () => { pendingMeta--; };
    run.then(done, done);
    chain = run.catch(() => {});
    return run;
  }

  return {
    /**
     * @param {{ budgetFolder: any, meta: object }} state
     * @param {(meta: object) => object | Promise<object>} patch
     */
    async update(state, patch) {
      const guard = () => {
        if (!state.budgetFolder) throw new StaleBudgetError();
        if (budgetHeld()) throw new BudgetLoadingError();
      };
      guard();
      return enqueue(state, async (folder, owned) => {
        guard();
        const next = await patch(state.meta || {});
        if (!owned()) throw new StaleBudgetError();
        guard();
        await save(folder, next);
        if (owned() && !budgetHeld()) state.meta = next;
        return next;
      });
    },

    /**
     * @param {{ budgetFolder: any, meta: object }} state
     * @param {(latestMeta: object) => Promise<{ meta: object, write: () => Promise<void> }>} fn
     */
    runExclusive(state, fn) {
      return enqueue(state, async (_folder, owned) => {
        const { meta, write } = await fn(state.meta || {});
        if (!owned()) throw new StaleBudgetError();
        await write();
        if (owned()) state.meta = meta;
        return meta;
      });
    },
  };
}
