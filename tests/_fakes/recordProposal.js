// Records an approved proposal the way the app does: its rows as
// transaction.record inputs (proposalToRecordSteps), all in one
// transaction.import, run through the real core pipeline over a plain budget.
// For the pure proposal tests that assert on the rows that end up stored.
import { registry } from '../../js/core/index.js';
import { runCommand } from '../../js/core/pipeline.js';
import { makeCtx } from '../../js/core/context.js';
import { proposalToRecordSteps } from '../../js/ai/proposal.js';

export const RECORD_NOW = new Date(2026, 9, 2, 10, 0, 0);

/**
 * @param {object} proposal  an approved (validated, possibly edited) proposal
 * @param {object} state     { accounts, envelopes, ... } the refs resolve against
 * @returns {object[]} the recorded rows, in order ([] when nothing is committable)
 */
export function recordProposal(proposal, state) {
  const rows = proposalToRecordSteps(proposal, state).map((s) => s.input);
  if (!rows.length) return [];
  let n = 0;
  const ctx = makeCtx({ now: RECORD_NOW, newId: () => `rec-${++n}` });
  const data = {
    meta: {}, budgetItems: [], envelopeTemplates: [], accounts: [], envelopes: [], transactions: [],
    ...state,
  };
  const r = runCommand(registry, data, 'transaction.import', { rows }, ctx);
  if (!r.ok) throw new Error(`transaction.import refused: ${JSON.stringify(r.error)}`);
  return r.value.value.rows;
}
