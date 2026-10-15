// js/ai/query.js — how the AI reads the budget's figures: through the core
// queries, never by calling the engine's balance and summary functions itself.
//
// The AI holds the app `state` (plain collections), not a session, so a query
// runs straight through the pipeline over a snapshot of it. The snapshot
// carries the very arrays the state holds (the engine's balance caches key on
// array identity) and the clock is the caller's, so a test pins "now".

import { registry } from '../core/index.js';
import { runQuery } from '../core/pipeline.js';
import { makeCtx } from '../core/context.js';

/**
 * The six collections a query reads, by identity. A collection the state
 * lacks is an empty one.
 * @param {any} state
 */
function snapshotOf(state) {
  return {
    envelopes: state.envelopes || [],
    budgetItems: state.budgetItems || [],
    transactions: state.transactions || [],
    accounts: state.accounts || [],
    envelopeTemplates: state.envelopeTemplates || [],
    meta: state.meta || {},
  };
}

/**
 * Run a core query over the app state.
 *
 * @param {any} state
 * @param {string} name   a registered query, e.g. 'balances'
 * @param {object} input
 * @param {() => Date} clock  the wall-clock read, injected by the caller
 * @returns {import('../core/result.js').Result}
 */
export function queryState(state, name, input, clock) {
  const ctx = makeCtx({ now: clock(), newId: () => 'ai', country: state.meta?.country ?? 'FI' });
  return runQuery(registry, snapshotOf(state), name, input, ctx);
}

/**
 * `queryState`, unwrapped: the answer, or a thrown error carrying the query's
 * failure `code` and `params`. For callers (a tool, a context builder) whose
 * own caller already turns a throw into an error result.
 *
 * @param {any} state
 * @param {string} name
 * @param {object} input
 * @param {() => Date} clock
 * @returns {any}
 */
export function queryAnswer(state, name, input, clock) {
  const r = queryState(state, name, input, clock);
  if (r.ok) return r.value;
  const err = new Error(`query ${name} failed: ${r.error.code} ${JSON.stringify(r.error.params)}`);
  /** @type {any} */ (err).code = r.error.code;
  /** @type {any} */ (err).params = r.error.params;
  throw err;
}
