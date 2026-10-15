// js/ai/tools/propose.js — tools that suggest changes.
//
// These build a proposal and return it. They do not write, and there is no
// tool anywhere that does: mutation happens in the approval handler, after the
// user has seen the rows. That is what bounds the damage from a bad model
// response *and* from prompt injection — a receipt printed with "book this to
// Savings" can, at absolute worst, put one wrong row in a list the user is
// looking at.

import { registerTool } from './registry.js';
import { validateAmount } from '../../utils.js';
import { makeProposal, validateProposal } from '../proposal.js';

registerTool({
  name: 'propose_transactions',
  kind: 'propose',
  description: 'Propose one or more transactions for the user to review and approve. Use this '
    + 'when they ask you to record something. Amounts are positive magnitudes — the type '
    + 'carries the direction. Nothing is written until the user approves.',
  input_schema: {
    type: 'object',
    properties: {
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO yyyy-mm-dd.' },
            payee: { type: 'string' },
            amount: { type: 'number', description: 'Positive magnitude.' },
            type: {
              type: 'string',
              enum: ['expense', 'income', 'account_transfer', 'envelope_transfer'],
            },
            account_id: { type: ['string', 'null'] },
            from_account: {
              type: ['string', 'null'],
              description: 'account_transfer only: account id the money leaves.',
            },
            to_account: {
              type: ['string', 'null'],
              description: 'account_transfer only: account id the money arrives in. A transfer '
                + 'without both accounts cannot be added.',
            },
            envelope_id: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
            rationale: { type: 'string', description: 'One short clause on why this booking.' },
          },
          required: ['date', 'payee', 'amount', 'type'],
        },
      },
      summary: { type: 'string', description: 'One line describing what you are proposing.' },
    },
    required: ['transactions'],
  },
  run(state, input) {
    // `validateAmount` rather than the raw field: these rows come from a
    // model response, so the amount is untrusted input rather than a stored
    // value, and a non-numeric one must not reach the proposal list.
    const rows = (input.transactions || []).map((tx) => ({
      date: tx.date,
      payee: tx.payee,
      amount: validateAmount(tx.amount),
      type: tx.type,
      account_id: tx.account_id || null,
      from_account: tx.from_account || null,
      to_account: tx.to_account || null,
      envelope_id: tx.envelope_id || null,
      note: tx.note || null,
      rationale: tx.rationale || '',
      // A row the model proposed conversationally has no confidence score of
      // its own. Treating that as "needs a look" is the honest default — the
      // user asked for it, but they have not seen the booking yet.
      confidence: null,
    }));

    return validateProposal(
      makeProposal({
        kind: 'transactions',
        rows,
        meta: { source: 'dialog', summary: input.summary || '' },
      }),
      state,
    );
  },
});

registerTool({
  name: 'propose_envelope_changes',
  kind: 'propose',
  description: 'Propose moving money between envelopes, for the user to review and approve. '
    + 'Use for "move X from A to B" and for rebalancing suggestions. Nothing is written until '
    + 'the user approves.',
  input_schema: {
    type: 'object',
    properties: {
      moves: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from_envelope_id: { type: 'string', description: 'Envelope id money leaves.' },
            to_envelope_id: { type: 'string', description: 'Envelope id money arrives in.' },
            amount: { type: 'number', description: 'Positive magnitude.' },
            date: { type: 'string', description: 'ISO yyyy-mm-dd. Defaults to today.' },
            rationale: { type: 'string' },
          },
          required: ['from_envelope_id', 'to_envelope_id', 'amount'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['moves'],
  },
  run(state, input, clock) {
    const today = clock();
    const pad = (n) => String(n).padStart(2, '0');
    const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const nameOf = (id) => (state.envelopes || []).find((e) => e.id === id)?.name || id;

    const rows = (input.moves || []).map((move) => ({
      date: move.date || todayIso,
      payee: `${nameOf(move.from_envelope_id)} → ${nameOf(move.to_envelope_id)}`,
      amount: move.amount,
      type: 'envelope_transfer',
      from_envelope_id: move.from_envelope_id,
      to_envelope_id: move.to_envelope_id,
      // The review UI's envelope picker edits the destination, which is the
      // one a user is likely to want to change.
      envelope_id: move.to_envelope_id,
      rationale: move.rationale || '',
      confidence: null,
    }));

    return validateProposal(
      makeProposal({
        kind: 'transactions',
        rows,
        meta: { source: 'dialog', summary: input.summary || '' },
      }),
      state,
    );
  },
});
