// tests/repair-envelope-transfer-ids.test.js
//
// Ledger repair for envelope transfers written with the pre-v3 endpoint names
// (`from_envelope` / `to_envelope`). The engine reads the `_id` forms, so those
// rows moved no money — and reported nothing, because the reference check
// returns early on a falsy `from_envelope_id`.
//
// The two properties that make an automatic repair safe here are asserted
// directly: it is IDEMPOTENT, and it PRESERVES ARRAY IDENTITY when there is
// nothing to do (the balance caches key on that identity).

import { describe, it, expect } from 'vitest';
import { repairEnvelopeTransferIds } from '../js/state/repair-envelope-transfer-ids.js';
import { computeEnvelopeBalances, runInvariantCheck } from '../js/engine.js';

const envelopes = [{ id: 'env-a', name: 'A' }, { id: 'env-b', name: 'B' }];

const broken = (over = {}) => ({
  id: 'tx-1',
  type: 'envelope_transfer',
  date: '2026-07-01',
  amount: 50,
  from_envelope: 'env-a',
  to_envelope: 'env-b',
  ...over,
});

describe('repairEnvelopeTransferIds', () => {
  it('renames both endpoints onto the canonical keys', () => {
    const r = repairEnvelopeTransferIds([broken()], { envelopes });
    const tx = r.transactions[0];
    expect(tx.from_envelope_id).toBe('env-a');
    expect(tx.to_envelope_id).toBe('env-b');
    expect(r.repaired).toBe(2);
    expect(r.rows).toBe(1);
  });

  it('drops the pre-v3 keys so the row cannot be repaired twice', () => {
    const tx = repairEnvelopeTransferIds([broken()], { envelopes }).transactions[0];
    expect('from_envelope' in tx).toBe(false);
    expect('to_envelope' in tx).toBe(false);
  });

  it('makes the transfer actually move money', () => {
    // The assertion that matters — a key-rename test alone proves nothing
    // about whether the engine now sees it.
    const seed = {
      id: 'seed', type: 'fill', date: '2026-06-01', status: 'posted',
      source: 'allocation',
      lines: [{ envelope_id: 'env-a', mode: 'add', amount: 100 }],
    };

    const before = computeEnvelopeBalances([seed, broken()]);
    expect(before.get('env-a')).toBeCloseTo(100, 5);   // transfer ignored
    expect(before.get('env-b') ?? 0).toBeCloseTo(0, 5);

    const after = computeEnvelopeBalances(
      repairEnvelopeTransferIds([seed, broken()], { envelopes }).transactions,
    );
    expect(after.get('env-a')).toBeCloseTo(50, 5);
    expect(after.get('env-b')).toBeCloseTo(50, 5);
  });

  it('clears the invariant problem the broken row raises', () => {
    const beforeCodes = runInvariantCheck({
      accounts: [], envelopes, transactions: [broken()],
    }).problems.map((p) => p.code);
    expect(beforeCodes).toContain('transferMissingEndpoints');

    const repaired = repairEnvelopeTransferIds([broken()], { envelopes }).transactions;
    const afterCodes = runInvariantCheck({
      accounts: [], envelopes, transactions: repaired,
    }).problems.map((p) => p.code);
    expect(afterCodes).not.toContain('transferMissingEndpoints');
  });

  it('is idempotent', () => {
    const once = repairEnvelopeTransferIds([broken()], { envelopes });
    const twice = repairEnvelopeTransferIds(once.transactions, { envelopes });
    expect(twice.repaired).toBe(0);
    expect(twice.rows).toBe(0);
    // And the second pass must hand back the SAME array, or every load after
    // the repair would bust the balance caches for nothing.
    expect(twice.transactions).toBe(once.transactions);
  });

  it('preserves array identity when there is nothing to repair', () => {
    const clean = [{
      id: 'ok', type: 'envelope_transfer', date: '2026-07-01', amount: 10,
      from_envelope_id: 'env-a', to_envelope_id: 'env-b',
    }];
    const r = repairEnvelopeTransferIds(clean, { envelopes });
    expect(r.transactions).toBe(clean);
    expect(r.repaired).toBe(0);
  });

  it('leaves rows of other types untouched, by identity', () => {
    const expense = {
      id: 'e1', type: 'expense', date: '2026-07-01', amount: 20,
      account: 'acct', envelope_id: 'env-a',
    };
    const r = repairEnvelopeTransferIds([expense, broken()], { envelopes });
    expect(r.transactions[0]).toBe(expense);
  });

  it('does not overwrite a canonical id that is already present', () => {
    const mixed = broken({ from_envelope: 'env-stale', from_envelope_id: 'env-a' });
    const tx = repairEnvelopeTransferIds([mixed], { envelopes }).transactions[0];
    expect(tx.from_envelope_id).toBe('env-a');   // canonical wins
    expect('from_envelope' in tx).toBe(false);   // stale key still dropped
  });

  it('repairs a one-sided row without inventing the missing side', () => {
    const oneSided = {
      id: 'tx-2', type: 'envelope_transfer', date: '2026-07-01', amount: 50,
      from_envelope: 'env-a',
    };
    const tx = repairEnvelopeTransferIds([oneSided], { envelopes }).transactions[0];
    expect(tx.from_envelope_id).toBe('env-a');
    expect(tx.to_envelope_id).toBeUndefined();
  });

  it('reports endpoints that no longer resolve, and keeps them', () => {
    // A dangling id is visible to runInvariantCheck; the silence it replaces
    // was not. Dropping it would hide the problem again.
    const gone = broken({ from_envelope: 'env-deleted' });
    const r = repairEnvelopeTransferIds([gone], { envelopes });
    expect(r.unresolved).toEqual(['env-deleted']);
    expect(r.transactions[0].from_envelope_id).toBe('env-deleted');

    const codes = runInvariantCheck({
      accounts: [], envelopes, transactions: r.transactions,
    }).problems.map((p) => p.code);
    expect(codes).toContain('unknownEnvelope');
  });

  it('ignores empty-string endpoints rather than promoting them', () => {
    const blank = broken({ from_envelope: '', to_envelope: '   ' });
    const r = repairEnvelopeTransferIds([blank], { envelopes });
    expect(r.repaired).toBe(0);
    const tx = r.transactions[0];
    expect(tx.from_envelope_id).toBeUndefined();
    expect('from_envelope' in tx).toBe(false);   // still cleaned up
  });

  it('tolerates malformed input', () => {
    expect(repairEnvelopeTransferIds(null).transactions).toBe(null);
    expect(repairEnvelopeTransferIds(undefined).repaired).toBe(0);
    expect(() => repairEnvelopeTransferIds([null, undefined, broken()])).not.toThrow();
  });
});
