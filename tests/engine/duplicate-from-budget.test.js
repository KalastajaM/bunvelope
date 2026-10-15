// `from_budget` is an idempotency key: one scheduled occurrence, one
// transaction. Four mechanisms trust it to be unique — the post-due
// materialiser's dedup, scheduled tombstones, the forecast's due-but-unposted
// netting, and the repair action that relinks a hand-recorded payment.
//
// Two rows sharing a key make an occurrence look settled that is only half
// settled, and every one of those mechanisms goes quiet about it. This is the
// only invariant that cannot be seen from a single transaction.

import { describe, it, expect } from 'vitest';
import { runInvariantCheck } from '../../js/engine.js';

// `date` defaults to a day inside the keyed month: a row dated far from the
// occurrence its key names is a DIFFERENT fault (`validateFromBudgetLink`),
// and letting it ride along here would make these cases fail for the wrong
// reason.
const tx = (id, from_budget, date = '2026-08-06') => ({
  id, type: 'expense', date, status: 'posted',
  amount: 183.6, envelope_id: 'e1', account: 'a1', payee: 'Property tax',
  ...(from_budget ? { from_budget } : {}),
});

const run = txs => runInvariantCheck({
  accounts: [{ id: 'a1' }], envelopes: [{ id: 'e1' }], transactions: txs,
});

describe('runInvariantCheck duplicate from_budget', () => {
  it('passes when every key is unique', () => {
    const r = run([tx('t1', 'bi:2026-08'), tx('t2', 'bi:2026-10', '2026-10-06')]);
    expect(r.byCategory.duplicateKeys).toBe(0);
    expect(r.totalProblems).toBe(0);
  });

  it('passes when rows carry no key at all', () => {
    const r = run([tx('t1'), tx('t2'), tx('t3')]);
    expect(r.byCategory.duplicateKeys).toBe(0);
  });

  it('flags two rows claiming the same occurrence', () => {
    const r = run([tx('t1', 'bi:2026-08'), tx('t2', 'bi:2026-08')]);
    expect(r.byCategory.duplicateKeys).toBe(2);
    expect(r.totalProblems).toBe(2);
  });

  it('flags every row involved, not just the extras', () => {
    // Neither row is knowably the original, so both need looking at.
    const r = run([tx('t1', 'bi:2026-08'), tx('t2', 'bi:2026-08')]);
    const ids = r.problems.filter(p => p.category === 'duplicateKeys').map(p => p.id);
    expect(ids.sort()).toEqual(['t1', 't2']);
  });

  it('reports the key and the total count in params', () => {
    const r = run([tx('t1', 'bi:2026-08'), tx('t2', 'bi:2026-08'), tx('t3', 'bi:2026-08')]);
    const p = r.problems.find(x => x.category === 'duplicateKeys');
    expect(p.code).toBe('duplicateFromBudget');
    expect(p.params).toEqual({ key: 'bi:2026-08', count: 3 });
    expect(r.byCategory.duplicateKeys).toBe(3);
  });

  it('keeps separate duplicate groups apart', () => {
    const r = run([
      tx('t1', 'bi:2026-08'), tx('t2', 'bi:2026-08'),
      tx('t3', 'other:2026-08'), tx('t4', 'other:2026-08'),
      tx('t5', 'unique:2026-08'),
    ]);
    expect(r.byCategory.duplicateKeys).toBe(4);
  });

  it('adds into totalProblems alongside the per-row invariants', () => {
    const bad = { ...tx('t3', 'bi:2026-08'), amount: -5 }; // also a sign violation
    const r = run([tx('t1', 'bi:2026-08'), bad]);
    expect(r.byCategory.duplicateKeys).toBe(2);
    expect(r.byCategory.signs).toBe(1);
    expect(r.totalProblems).toBe(3);
  });

  it('ignores a non-string from_budget', () => {
    const weird = { ...tx('t1'), from_budget: 42 };
    const weird2 = { ...tx('t2'), from_budget: 42 };
    expect(run([weird, weird2]).byCategory.duplicateKeys).toBe(0);
  });
});
