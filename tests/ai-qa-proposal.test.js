// tests/ai-qa-proposal.test.js — QA 2026-09-23 #1: the AI import trusted the
// model's `type` over the bank row's sign, and an account_transfer never got
// its other leg. A +500 "Transfer from savings" typed account_transfer and a
// +15 refund typed expense left checking at −515 instead of +515.

import { describe, it, expect } from 'vitest';
import { needsReview, committableRows } from '../js/ai/proposal.js';
import { buildImportProposal } from '../js/import/build-proposal.js';
import { txAccountDelta } from '../js/engine.js';
import { recordProposal } from './_fakes/recordProposal.js';

function fixtureState() {
  return {
    envelopes: [{ id: 'env-groceries', name: 'Groceries' }],
    accounts: [
      { id: 'acc-checking', name: 'Checking' },
      { id: 'acc-savings', name: 'Savings' },
    ],
    transactions: [],
  };
}

/** The import sheet's path: parsed CSV rows + the model's categorizations. */
function importProposal(csvRows, assignments, accountId = 'acc-checking') {
  const matched = csvRows.map((csvRow) => ({ csvRow, match: null, matchType: 'none' }));
  const needing = csvRows.map((r, i) => ({ ...r, __sourceIndex: i }));
  return buildImportProposal({
    matched, needing, categorized: assignments, state: fixtureState(),
    defaultAccountId: accountId,
  });
}

const net = (txs, acct) => txs.reduce((s, t) => s + txAccountDelta(t, acct), 0);

describe('bank sign beats the model type', () => {
  it('books a +15 refund the model called an expense as money in, flagged', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'Lidl refund', amount: 15 }],
      [{ type: 'expense', envelope_id: 'env-groceries', account_id: 'acc-checking', confidence: 0.95 }],
    );
    const [row] = p.rows;
    expect(row.type).toBe('income');
    expect(row.warnings.map((w) => w.code)).toContain('sign_mismatch');
    expect(needsReview(row)).toBe(true);
    const txs = recordProposal(p, fixtureState());
    expect(net(txs, 'acc-checking')).toBe(15);
  });

  it('books a −20 row the model called income as money out, flagged', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'Shop', amount: -20 }],
      [{ type: 'income', envelope_id: null, account_id: 'acc-checking', confidence: 0.9 }],
    );
    expect(p.rows[0].type).toBe('expense');
    expect(p.rows[0].warnings.map((w) => w.code)).toContain('sign_mismatch');
  });

  it('does not flag rows whose type agrees with the sign', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'Shop', amount: -20 }],
      [{ type: 'expense', envelope_id: 'env-groceries', account_id: 'acc-checking', confidence: 0.9 }],
    );
    expect(p.rows[0].warnings).toEqual([]);
  });

  it('leaves model-proposed dialog rows (positive magnitudes) alone', async () => {
    const { makeProposal, validateProposal } = await import('../js/ai/proposal.js');
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [{ date: '2026-01-05', payee: 'Shop', amount: 20, type: 'expense', account_id: 'acc-checking' }],
    }), fixtureState());
    expect(p.rows[0].type).toBe('expense');
    expect(p.rows[0].warnings).toEqual([]);
  });
});

describe('transfers take their direction from the bank sign', () => {
  it('an incoming transfer lands in the import account and needs its source', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'Transfer from savings', amount: 500 }],
      [{ type: 'account_transfer', envelope_id: null, account_id: 'acc-checking', confidence: 0.9 }],
    );
    const [row] = p.rows;
    expect(row.type).toBe('account_transfer');
    expect(row.transfer_direction).toBe('in');
    expect(row.account_id).toBe('acc-checking');
    expect(row.counter_account).toBe(null);
    expect(row.warnings.map((w) => w.code)).toContain('transfer_needs_account');
    // Not committable until the other leg is chosen.
    expect(row.excluded).toBe(true);
    expect(committableRows(p)).toHaveLength(0);
    // And forcing it in is refused rather than writing half a transfer.
    row.excluded = false;
    expect(() => recordProposal(p, fixtureState())).toThrow(expect.objectContaining({ code: 'transfer_needs_account' }));
  });

  it('once the other account is chosen, checking goes UP by the transfer', () => {
    const p = importProposal(
      [
        { date: '2026-01-05', payee: 'Transfer from savings', amount: 500 },
        { date: '2026-01-06', payee: 'Lidl refund', amount: 15 },
      ],
      [
        { type: 'account_transfer', envelope_id: null, account_id: 'acc-checking', confidence: 0.9 },
        { type: 'expense', envelope_id: 'env-groceries', account_id: 'acc-checking', confidence: 0.9 },
      ],
    );
    const transfer = p.rows.find((r) => r.type === 'account_transfer');
    transfer.counter_account = 'acc-savings'; // what the review picker sets
    transfer.excluded = false;
    const txs = recordProposal(p, fixtureState());
    expect(net(txs, 'acc-checking')).toBe(515);
    expect(net(txs, 'acc-savings')).toBe(-500);
    const tr = txs.find((t) => t.type === 'account_transfer');
    expect(tr).toMatchObject({ from_account: 'acc-savings', to_account: 'acc-checking', amount: 500 });
  });

  it('an outgoing transfer leaves the import account', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'To savings', amount: -200 }],
      // The model named the savings account: that is the other side, not ours.
      [{ type: 'account_transfer', envelope_id: null, account_id: 'acc-savings', confidence: 0.9 }],
    );
    const [row] = p.rows;
    expect(row.transfer_direction).toBe('out');
    expect(row.account_id).toBe('acc-checking');
    expect(row.counter_account).toBe('acc-savings');
    expect(row.excluded).toBeFalsy();
    const txs = recordProposal(p, fixtureState());
    expect(net(txs, 'acc-checking')).toBe(-200);
    expect(net(txs, 'acc-savings')).toBe(200);
  });

  it('refuses a transfer whose two sides are the same account', () => {
    const p = importProposal(
      [{ date: '2026-01-05', payee: 'x', amount: -200 }],
      [{ type: 'account_transfer', envelope_id: null, account_id: 'acc-checking', confidence: 0.9 }],
    );
    const [row] = p.rows;
    row.counter_account = 'acc-checking';
    row.excluded = false;
    expect(() => recordProposal(p, fixtureState())).toThrow(expect.objectContaining({ code: 'transfer_needs_account' }));
  });
});
