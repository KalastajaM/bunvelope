// tests/audit-fixes-2026-08-26.test.js
//
// Three defects found during the rebuild audit, each silent in a different way.
//
// The shared shape is worth naming: all three are a rule that existed correctly
// in one place and was re-stated — wrongly, or with the wrong assumption — in
// another. None of them threw, and none of them showed a symptom at the point
// of failure.

import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalances,
  runInvariantCheck,
  isIncomeLikeItem,
} from '../js/engine.js';
import { makeProposal, validateProposal } from '../js/ai/proposal.js';
import { recordProposal } from './_fakes/recordProposal.js';

// ───────────────────────────────────────────────────────────────────────────
// 1. AI-proposed envelope transfers moved no money.
//
// The proposal writer and the envelope-move tool emitted `from_envelope` /
// `to_envelope` — the PRE-v3 field names, renamed by the v2→v3 migration in
// js/storage/fsapi-adapter.js. The engine reads `from_envelope_id` /
// `to_envelope_id`, so an accepted transfer changed nothing in either
// envelope. It was invisible to the invariant badge too, because the
// reference check returns early on a falsy `from_envelope_id`.
// ───────────────────────────────────────────────────────────────────────────

describe('AI envelope transfers move money', () => {
  const envelopes = [{ id: 'env-a', name: 'A' }, { id: 'env-b', name: 'B' }];
  const accounts = [{ id: 'acct', name: 'Main', initialBalance: 0 }];

  const commit = () => recordProposal(
    validateProposal(makeProposal({
      kind: 'transactions',
      rows: [{
        date: '2026-08-26',
        payee: 'A → B',
        amount: 50,
        type: 'envelope_transfer',
        from_envelope_id: 'env-a',
        to_envelope_id: 'env-b',
      }],
      meta: { source: 'dialog' },
    }), { envelopes, accounts }),
    { envelopes, accounts },
  );

  it('writes the field names the engine actually reads', () => {
    const row = commit()[0];
    expect(row.from_envelope_id).toBe('env-a');
    expect(row.to_envelope_id).toBe('env-b');
    // The pre-v3 names must be gone, not merely accompanied.
    expect(row.from_envelope).toBeUndefined();
    expect(row.to_envelope).toBeUndefined();
  });

  it('actually moves the balance once committed', () => {
    // The assertion that matters. A field-name test alone would pass against a
    // consistent-but-wrong pair of names; this one goes through the engine.
    const txs = commit();
    const seed = {
      id: 'seed', type: 'fill', date: '2026-08-01', status: 'posted',
      source: 'allocation',
      lines: [{ envelope_id: 'env-a', mode: 'add', amount: 100 }],
    };
    const balances = computeEnvelopeBalances([seed, ...txs]);
    expect(balances.get('env-a')).toBeCloseTo(50, 5);
    expect(balances.get('env-b')).toBeCloseTo(50, 5);
  });

  it('surfaces a legacy transfer that names neither endpoint', () => {
    // Rows accepted before the fix are still in real ledgers and move no
    // money. Nothing reported them: they resolve no ids, so the ref check
    // returns early, and the invariant badge stayed clean.
    const broken = {
      id: 'legacy-1', type: 'envelope_transfer', date: '2026-07-01',
      amount: 50, from_envelope: 'env-a', to_envelope: 'env-b',
    };
    const report = runInvariantCheck({
      accounts, envelopes, transactions: [broken],
    });

    expect(report.totalProblems).toBeGreaterThan(0);
    const codes = report.problems.map((p) => p.code);
    expect(codes).toContain('transferMissingEndpoints');
  });

  it('does not flag a well-formed transfer', () => {
    const ok = {
      id: 'ok-1', type: 'envelope_transfer', date: '2026-07-01',
      amount: 50, from_envelope_id: 'env-a', to_envelope_id: 'env-b',
    };
    const report = runInvariantCheck({ accounts, envelopes, transactions: [ok] });
    const codes = report.problems.map((p) => p.code);
    expect(codes).not.toContain('transferMissingEndpoints');
  });

  it('does not flag a one-sided transfer', () => {
    // Only ONE endpoint missing is a different fault and is left to the ref
    // checks — this guard is specifically for a row that moves nothing at all.
    const oneSided = {
      id: 'one-1', type: 'envelope_transfer', date: '2026-07-01',
      amount: 50, from_envelope_id: 'env-a',
    };
    const report = runInvariantCheck({ accounts, envelopes, transactions: [oneSided] });
    const codes = report.problems.map((p) => p.code);
    expect(codes).not.toContain('transferMissingEndpoints');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Dividend plan items counted as expenses.
//
// js/pages/stress.js used a bare `kind === 'income'` test instead of the
// engine's predicate, so a dividend-direction investment transfer — which
// credits cash and drives no envelope debit — landed in the expense bucket.
// Overstated burn and understated runway in every scenario.
// ───────────────────────────────────────────────────────────────────────────

describe('income classification', () => {
  it('treats a dividend investment transfer as income-like', () => {
    expect(isIncomeLikeItem({ kind: 'investment_transfer', direction: 'dividend' })).toBe(true);
  });

  it('treats an investment buy as an expense', () => {
    // Buys debit the investing envelope, so they must NOT partition as income.
    expect(isIncomeLikeItem({ kind: 'investment_transfer', direction: 'buy' })).toBe(false);
    expect(isIncomeLikeItem({ kind: 'investment_transfer' })).toBe(false);
  });

  it('keeps plain income and plain expense unchanged', () => {
    expect(isIncomeLikeItem({ kind: 'income' })).toBe(true);
    expect(isIncomeLikeItem({ kind: 'expense' })).toBe(false);
    expect(isIncomeLikeItem(null)).toBe(false);
  });

  it('is reachable from the engine facade', () => {
    // The reason stress.js grew its own copy: the predicate lived only in an
    // engine-internal module that callers are told not to import.
    expect(typeof isIncomeLikeItem).toBe('function');
  });

  it('a bare kind check disagrees on exactly the dividend case', () => {
    // Pins WHY the shortcut is wrong, so a future "simplification" back to
    // `kind === 'income'` fails here rather than silently in a runway figure.
    const dividend = { kind: 'investment_transfer', direction: 'dividend' };
    expect(dividend.kind === 'income').toBe(false);
    expect(isIncomeLikeItem(dividend)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Identity-keyed caches require reassignment, not mutation.
//
// js/pages/budget-plan.js mutated state.budgetItems in place, so the array
// identity never changed — and the forecast cache keys on exactly that, with
// no explicit invalidation API. A planned item creates no transaction either,
// so no other element of the cache key moved.
// ───────────────────────────────────────────────────────────────────────────

describe('identity-keyed caches see reassignment, not mutation', () => {
  const seed = (amount) => ([{
    id: 'f1', type: 'fill', date: '2026-08-01', status: 'posted',
    source: 'allocation',
    lines: [{ envelope_id: 'env-a', mode: 'add', amount }],
  }]);

  it('serves a STALE balance after an in-place edit', () => {
    // Demonstrates the hazard directly against the real memoizer, rather than
    // asserting JS reference semantics. This is why budget-plan.js reassigning
    // matters: the cache has no invalidation API and identity is the only
    // signal it has.
    const txs = seed(100);
    expect(computeEnvelopeBalances(txs).get('env-a')).toBeCloseTo(100, 5);

    txs[0].lines[0].amount = 250;                 // mutate in place
    expect(computeEnvelopeBalances(txs).get('env-a')).toBeCloseTo(100, 5); // ← stale
  });

  it('serves a FRESH balance after a reassignment', () => {
    const txs = seed(100);
    expect(computeEnvelopeBalances(txs).get('env-a')).toBeCloseTo(100, 5);

    const next = [{ ...txs[0], lines: [{ envelope_id: 'env-a', mode: 'add', amount: 250 }] }];
    expect(computeEnvelopeBalances(next).get('env-a')).toBeCloseTo(250, 5);
  });

  it('the cached Map refuses mutation outright', () => {
    // Object.freeze does not protect a Map, so the cache overrides its
    // mutators — an accidental write surfaces immediately instead of
    // corrupting every later read.
    const cached = computeEnvelopeBalances(seed(100));
    expect(() => cached.set('env-a', 999)).toThrow();
  });
});
