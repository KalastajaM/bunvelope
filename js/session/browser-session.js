// js/session/browser-session.js — the browser's single writer. Pages that have
// moved to the command layer call session.dispatch(...); the session validates
// and runs the command through the core pipeline, writes through the storage
// facade, and only then publishes into `state`. Spec 2026-10-01 §6.2.
//
// The browser writes every collection and meta (BROWSER_WRITABLE): transactions,
// accounts, envelopes, budgetItems and envelopeTemplates. Edits and deletes of
// transactions are logged by the session itself. Meta takes
// one of two paths:
//
// - A meta-primary command (its diff changes any meta key) commits inside the
//   app's meta queue (deps.runMetaExclusive), in the queue's order, on the
//   LATEST meta, so a write queued ahead of it is not lost. Meta is
//   top-level-key granular: a key whose both sides are arrays of primitives
//   (scheduledTombstones, closed_months, ...) merges by element when it moved
//   meanwhile, so a concurrent change to it is never a conflict (unmoved, it
//   is stored exactly as the command produced it); every other key is replaced
//   wholesale. If every such wholesale key still holds its `before`, the diff
//   applies; otherwise the command runs once more on the latest data.
//   Collections, meta and the change log then go in ONE writeBatch, and nothing
//   is published unless it lands. Undo of such a commit takes the same path,
//   with the same element merge.
// - Collection-only commands use the same atomic path. Every save includes
//   financial revision history in meta; a failed history write fails the whole
//   batch. Undo appends a revision and never rewinds the history itself.
//
// Dispatches run one at a time, and a write that finishes after a budget switch
// publishes nothing. Each dispatch is bound to the budget open when it was
// called: one still queued when the budget switches is refused with
// budget_switched (an Undo with undo_stale) when its turn comes, before it
// reads or writes anything, so it never runs against the cleared state or the
// next budget. Nothing is read or written while a load or the setup wizard
// holds the budget (deps.isLoading, js/state/budget-session.js): such a
// dispatch, batch, undo or queryAfter is refused with budget_loading, when called and
// again when its turn comes. Unlike a switch it is not silent: the user acted
// on a budget that is not there yet, and the change was not saved.
//
// So the session is the only thing that replaces a collection while one of
// its writes is in flight, and it writes one at a time: no page writes a
// collection (every kind's save function is banned outside storage, see
// below); the budget pickers clear `state` in the same synchronous block as
// the loader starts its budget session, which a write in flight sees as a
// switch; and the loader and the setup wizard publish the collections only
// while they hold the budget, when no write can have started. The publish
// therefore needs no rebase onto rows replaced mid-write, and has none.
//
// A kind joins BROWSER_WRITABLE in the same PR as its save functions join
// bunvelope/no-direct-collection-save (eslint.config.js). The test that ties
// the two together is tests/lint-collection-save.test.js: for every writable
// kind other than meta, its save function's allow list must be empty and no
// file outside the exempt bootstrap writers may batch-write its file. commit()
// enforces the scope with BROWSER_WRITABLE.

import { ok, fail } from '../core/result.js';
import { makeCtx } from '../core/context.js';
import { runCommand, runBatch, runQuery } from '../core/pipeline.js';
import { rowDiff, invert, applyDiff, mergeMetaChanges, mergesByElement, deepEqual } from '../core/diff.js';
import { resolvePolicies } from '../core/policies/index.js';
import { applyCommitChecks } from './commit-checks.js';
import { appendFinancialHistory } from '../core/financial-history.js';
import { changeLogEntries } from './audit.js';
import { appendChangeLog } from '../state/change-log.js';
import { StaleBudgetError } from '../state/meta-queue.js';

export const COLLECTION_FILES = Object.freeze({
  envelopes: 'envelopes.json',
  budgetItems: 'budget-items.json',
  transactions: 'transactions.json',
  accounts: 'accounts.json',
  envelopeTemplates: 'envelope-templates.json',
  meta: 'budget-meta.json',
});
const KINDS = Object.keys(COLLECTION_FILES);
// What the browser may write today; see the header. Frozen, so nothing widens
// it at runtime: a test that needs a different scope passes `writableKinds`
// to createBrowserSession instead.
export const BROWSER_WRITABLE = Object.freeze(['transactions', 'meta', 'accounts', 'envelopes', 'budgetItems', 'envelopeTemplates']);

// Whether `latest` still holds every wholesale key's `before`. A key that
// merges by element (mergeMetaChanges) cannot conflict.
const metaUnmoved = (metaDiff, latest) => (metaDiff?.changed ?? []).every(c => mergesByElement(c) || deepEqual(latest[c.key], c.before));

/**
 * `diff` applied to `data`, strictly for collections and wholesale meta keys
 * (applyDiff), by element for primitive-array meta keys (mergeMetaChanges).
 * @param {Record<string, any>} data
 * @param {Record<string, any>} diff
 */
function applyWithElementMerge(data, diff) {
  const elementwise = (diff.meta?.changed ?? []).filter(mergesByElement);
  if (!elementwise.length) return applyDiff(data, diff);
  const wholesale = diff.meta.changed.filter(c => !mergesByElement(c));
  const { meta: _meta, ...rest } = diff;
  const applied = applyDiff(data, wholesale.length ? { ...rest, meta: { changed: wholesale } } : rest);
  if (!applied.ok) return applied;
  return ok({ ...applied.value, meta: mergeMetaChanges(applied.value.meta ?? data.meta, { changed: elementwise }) });
}

// Ends a meta-primary commit early with `result`, from inside the meta queue,
// so the queue neither writes nor assigns meta.
class EarlyResult extends Error {
  /** @param {any} result */
  constructor(result) { super('commit ended early'); this.result = result; }
}

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.state
 * @param {any} deps.registry
 * @param {(ref: any, items: { filename: string, data: any }[]) => Promise<any>} deps.writeBatch
 * @param {() => number} deps.currentGeneration
 * @param {(...kinds: string[]) => void} deps.notify
 * @param {() => Date} deps.clock
 * @param {() => string} deps.newId
 * @param {(state: any, patch: (meta: any) => any) => Promise<any>} deps.updateMeta
 * @param {(state: any, fn: (latestMeta: any) => Promise<{ meta: any, write: () => Promise<void> }>) => Promise<any>} deps.runMetaExclusive
 * @param {(state: any) => void} [deps.onTransactionsPublished]
 * @param {(err: any) => boolean} [deps.isVersionConflict]
 * @param {() => boolean} [deps.isLoading] true while a load or the setup wizard holds the budget: every write is refused with budget_loading
 * @param {Set<string>} [deps.writableKinds] collections a command may change; defaults to BROWSER_WRITABLE (tests only)
 */
export function createBrowserSession(deps) {
  const {
    state, registry, writeBatch, currentGeneration, notify, clock, newId, runMetaExclusive,
    onTransactionsPublished = () => {}, isVersionConflict = () => false,
    isLoading = () => false,
    writableKinds = new Set(BROWSER_WRITABLE),
  } = deps;
  /** @type {Promise<any>} */
  let queue = Promise.resolve();

  const snapshot = () => Object.fromEntries(KINDS.map(k => [k, state[k]]));
  const ctx = () => makeCtx({ now: clock(), newId, country: state.meta?.country ?? 'FI' });
  const items = (changes) => Object.entries(changes).map(([kind, data]) => ({ filename: COLLECTION_FILES[kind], data }));

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  function policiesFor(names, meta = state.meta) {
    const stored = Array.isArray(meta?.policies) ? meta.policies : [];
    return resolvePolicies([...stored, ...(names || [])]);
  }

  async function write(ref, changes) {
    try {
      await writeBatch(ref, items(changes));
      return null;
    } catch (err) {
      if (isVersionConflict(err)) return fail('version_conflict', {});
      return fail('write_failed', { message: String(err?.message || err) });
    }
  }

  /** @param {Record<string, any>} changes @param {...string} also  kinds already assigned elsewhere, notified with these */
  function publish(changes, ...also) {
    const kinds = Object.keys(changes);
    for (const kind of kinds) state[kind] = changes[kind];
    if (kinds.includes('transactions')) onTransactionsPublished(state);
    notify(...kinds, ...also);
  }

  // The budget a dispatch belongs to, taken when it is called.
  const bind = () => ({ ref: state.budgetFolder, generation: currentGeneration() });
  const switchedSince = (bound) => bound.generation !== currentGeneration() || bound.ref !== state.budgetFolder;
  // Whether a load or the setup wizard holds the open budget. A hold with no
  // budget open (the welcome screen after the startup reopen found no budget
  // and set budgetFolder null, leaving the wizard's hold) is just no budget,
  // which run() refuses as no_budget.
  const held = () => Boolean(state.budgetFolder) && isLoading();

  // Only collections the diff says changed are written or published. The
  // commit checks hand back a fresh array for every collection they saw; an
  // unchanged one is not worth a write.
  function scoped(proposed, diff) {
    const changes = Object.fromEntries(Object.entries(proposed).filter(([kind]) => diff[kind]));
    for (const kind of Object.keys(changes)) {
      if (!writableKinds.has(kind)) {
        throw new TypeError(`BrowserSession: ${kind} is not writable from the browser yet; see BACKLOG "Prerequisite for slice 2" and docs/superpowers/specs/2026-10-02-api-first-core-slice-2-design.md §6.1`);
      }
    }
    return changes;
  }

  /**
   * After the write landed: publish nothing into a budget that switched while
   * it was in flight. Returns the collections to publish, or the result to
   * return instead.
   * @returns {{ published: Record<string, any> } | { result: any }}
   */
  function settle({ ref, generation, collections, diff, value, forced }) {
    if (switchedSince({ ref, generation })) {
      return { result: ok({ value, diff, forced, committed: true, published: false, undo: null }) };
    }
    return { published: collections };
  }

  /**
   * @param {object} c
   * @param {any} c.ref
   * @param {number} c.generation
   * @param {Record<string, any>} c.before  the data the change was computed on
   * @param {Record<string, any>} c.changes
   * @param {Record<string, any>} c.diff
   * @param {any} c.value
   * @param {string[]} c.forced
   * @param {(data: Record<string, any>) => any} c.compute  runs the command (or the undo) again on `data`
   * @param {any} c.stale  the result when the budget switched before anything was written
   */
  async function commit(c) {
    const changes = scoped(c.changes, c.diff);
    if (c.diff.meta?.changed.length && c.diff.meta.changed.every(change => change.key === 'change_log')) throw new TypeError('BrowserSession: commands cannot write change_log themselves');
    return commitWithMeta({ ...c, changes });
  }

  // The atomic commit path; see the header. Collections and meta land in one
  // writeBatch from inside the meta queue, and are published only if it does.
  async function commitWithMeta({ ref, generation, compute, stale, ...first }) {
    let attempt = first;
    // What write() publishes once the batch has landed and settled.
    /** @type {Record<string, any>} */
    let published = {};
    try {
      await runMetaExclusive(state, async (latest) => {
        if (switchedSince({ ref, generation })) throw new StaleBudgetError();
        if (!metaUnmoved(attempt.diff.meta, latest) || !deepEqual(attempt.before.meta?.policies, latest.policies)
          || !deepEqual(attempt.before.meta?.importRules, latest.importRules)
          || !deepEqual(attempt.before.meta?.payeeAliases, latest.payeeAliases)) {
          // A write queued ahead changed a key this commit replaces wholesale:
          // run it once more on the latest data, through the same pipeline.
          const data = { ...snapshot(), meta: latest };
          const again = compute(data);
          if (!again.ok) throw new EarlyResult(again);
          const { value, changes, diff, forced } = again.value;
          if (Object.keys(diff).length === 0) throw new EarlyResult(ok({ value, diff, forced, committed: false }));
          // The re-run's diff is computed on `latest`, so every `before` it
          // holds is latest's own value: it cannot conflict again.
          attempt = { before: data, changes: scoped(changes, diff), diff, value, forced };
        }
        const { before, changes, diff, value, forced } = attempt;
        const { meta: _meta, ...collections } = changes;
        const committedAt = clock();
        const entries = changeLogEntries(before, collections, committedAt.toISOString());
        const merged = diff.meta ? mergeMetaChanges(latest, diff.meta) : latest;
        const logged = entries.length ? appendChangeLog(merged, entries) : merged;
        const meta = { ...logged, financialHistory: appendFinancialHistory(
          { ...before, meta: latest }, { ...before, ...collections, meta: logged }, committedAt) };
        return {
          meta,
          write: async () => {
            // Meta last: the fsapi adapter's commit marker.
            const failed = await write(ref, { ...collections, meta });
            if (failed) throw new EarlyResult(failed);
            const settled = settle({ ref, generation, collections, diff, value, forced });
            // Throwing keeps the queue from assigning meta into a switched budget.
            if ('result' in settled) throw new EarlyResult(settled.result);
            published = settled.published;
          },
        };
      });
    } catch (err) {
      if (err instanceof EarlyResult) return err.result;
      if (err instanceof StaleBudgetError) return stale;
      throw err;
    }
    const { diff, value, forced } = attempt;
    if (switchedSince({ ref, generation })) return ok({ value, diff, forced, committed: true, published: false, undo: null });
    // The queue has assigned state.meta.
    publish(published, 'meta');
    const undoDiff = { ...diff };
    if (undoDiff.meta) {
      const changed = undoDiff.meta.changed.filter(c => !['financialHistory', 'change_log'].includes(c.key));
      if (changed.length) undoDiff.meta = { changed }; else delete undoDiff.meta;
    }
    return ok({ value, diff, forced, committed: true, published: true,
      undo: Object.keys(undoDiff).length ? { generation, ref, diff: undoDiff } : null });
  }

  /**
   * @param {(data: any, policies: any[]) => any} compute
   * @param {{ dryRun?: boolean, policies?: string[] }} opts
   * @param {{ ref: any, generation: number }} bound
   * @param {(after: Record<string, any>) => any} [answer]  queryAfter only: a dry
   *   run whose result is this, asked of the data the steps produced
   */
  async function run(compute, { dryRun = false, policies } = {}, bound, answer) {
    if (!state.budgetFolder) return fail('no_budget', {});
    if (switchedSince(bound)) return fail('budget_switched', {});
    // Checked again on its turn: the wizard holds the session the loader
    // started, so a hold can begin without a new generation.
    if (held()) return fail('budget_loading', {});
    const resolved = policiesFor(policies);
    if (!resolved.ok) return resolved;
    const ref = state.budgetFolder;
    const generation = currentGeneration();
    const before = snapshot();
    const rerun = (data) => {
      const current = policiesFor(policies, data.meta);
      return current.ok ? compute(data, current.value) : current;
    };
    const r = rerun(before);
    if (!r.ok) return r;
    if (answer) return answer(r.value.after);
    const { value, changes, diff, forced } = r.value;
    if (dryRun || Object.keys(diff).length === 0) return ok({ value, diff, forced, committed: false });
    return commit({ ref, generation, before, changes, diff, value, forced, compute: rerun, stale: fail('budget_switched', {}) });
  }

  return {
    /** @param {string} name @param {any} input */
    query(name, input) {
      if (!state.budgetFolder) return fail('no_budget', {});
      return runQuery(registry, snapshot(), name, input, ctx());
    },

    /** @param {string} name @param {any} input @param {{ dryRun?: boolean, policies?: string[] }} [opts] */
    dispatch(name, input, opts = {}) {
      if (held()) return Promise.resolve(fail('budget_loading', {}));
      const bound = bind();
      return serialize(() => run(
        (data, policies) => runCommand(registry, data, name, input, ctx(), { policies, checks: applyCommitChecks }),
        opts,
        bound,
      ));
    },

    /** @param {{ name: string, input: any }[]} steps @param {{ dryRun?: boolean, policies?: string[] }} [opts] */
    dispatchBatch(steps, opts = {}) {
      if (held()) return Promise.resolve(fail('budget_loading', {}));
      const bound = bind();
      return serialize(() => run(
        (data, policies) => runBatch(registry, data, steps, ctx(), { policies, checks: applyCommitChecks }),
        opts,
        bound,
      ));
    },

    /**
     * Query `name` asked of the budget as it would be after `steps`: a dry run
     * of the steps (queued behind pending writes, refused while a load holds
     * the budget, policies applied, commit checks included), then the query on
     * the data they produce. A refused step returns that step's error. Nothing
     * is written or published.
     * @param {{ name: string, input: any }[]} steps @param {string} name @param {any} input
     */
    queryAfter(steps, name, input) {
      if (held()) return Promise.resolve(fail('budget_loading', {}));
      const bound = bind();
      return serialize(() => {
        // One clock for the steps and the query, so both see the same today.
        const c = ctx();
        return run(
          (data, policies) => runBatch(registry, data, steps, c, { policies, checks: applyCommitChecks }),
          { dryRun: true },
          bound,
          (after) => runQuery(registry, after, name, input, c),
        );
      });
    },

    /** @param {{ generation: number, ref: any, diff: any } | null} token */
    undo(token) {
      if (held()) return Promise.resolve(fail('budget_loading', {}));
      const bound = bind();
      return serialize(async () => {
        if (!token || switchedSince(bound) || token.generation !== currentGeneration() || token.ref !== state.budgetFolder) {
          return fail('undo_stale', { reason: token ? 'budget_changed' : 'missing_token' });
        }
        if (held()) return fail('budget_loading', {});
        // The inverse applied to `data`, shaped like a command's result so the
        // meta-primary path can apply it again on the latest meta.
        const compute = (data) => {
          const applied = applyWithElementMerge(data, invert(token.diff));
          if (!applied.ok) return fail('undo_stale', { ...applied.error.params });
          const checked = applyCommitChecks(data, applied.value, { allowUnknownTypes: true, applyAliases: false });
          if (!checked.ok) return checked;
          return ok({ value: null, changes: checked.value, diff: rowDiff(data, checked.value), forced: [] });
        };
        const before = snapshot();
        const r = compute(before);
        if (!r.ok) return r;
        return commit({
          ref: token.ref, generation: token.generation, before, ...r.value, compute, stale: fail('undo_stale', { reason: 'budget_changed' }),
        });
      });
    },
  };
}
