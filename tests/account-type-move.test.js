// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { identityMove, moveAdjustment } from '../js/pages/account-type-move.js';

const savings = { id: 'sav', type: 'savings', initialBalance: 55000 };
const accounts = [savings, { id: 'chk', type: 'bank', initialBalance: 100 }];

describe('identityMove', () => {
  it('is the balance leaving budget cash when a savings account becomes a loan given', () => {
    expect(identityMove(savings, 'loan_given', accounts, [])).toEqual({ balance: 55000, leaving: true });
  });
  it('is the balance joining budget cash the other way round', () => {
    const lg = { ...savings, type: 'loan_given' };
    expect(identityMove(lg, 'savings', [lg], [])).toEqual({ balance: 55000, leaving: false });
  });
  it('is null when the change stays on one side, or the balance is zero', () => {
    expect(identityMove(savings, 'bank', accounts, [])).toBeNull();
    expect(identityMove({ ...savings, type: 'asset' }, 'loan_given', accounts, [])).toBeNull();
    expect(identityMove({ ...savings, initialBalance: 0 }, 'loan_given', [{ ...savings, initialBalance: 0 }], [])).toBeNull();
  });
});

describe('moveAdjustment', () => {
  const meta = { id: 'x', date: '2026-10-01', note: 'n', nowIso: '2026-10-01T00:00:00Z' };
  it('releases the envelope when the money leaves budget cash', () => {
    expect(moveAdjustment({ balance: 55000, leaving: true }, 'loans', meta)).toMatchObject({
      type: 'adjustment', target: 'envelope', target_id: 'loans', amount: -55000, date: '2026-10-01',
    });
  });
  it('funds the envelope when it joins', () => {
    expect(moveAdjustment({ balance: 55000, leaving: false }, 'loans', meta).amount).toBe(55000);
  });
  it('is null for Unallocated', () => {
    expect(moveAdjustment({ balance: 55000, leaving: true }, null, meta)).toBeNull();
  });
});

describe('switching with the envelope released', () => {
  it('leaves Unallocated exactly where it was', async () => {
    const { computeUnallocated, computeAccountBalances, computeEnvelopeBalances } = await import('../js/engine.js');
    const fill = { id: 'f', type: 'fill', date: '2026-01-01', lines: [{ envelope_id: 'loans', amount: 55000 }], status: 'posted' };
    const u = (accts, txs) => computeUnallocated(computeAccountBalances(accts, txs), computeEnvelopeBalances(txs), accts);
    const before = u(accounts, [fill]);
    const move = identityMove(savings, 'loan_given', accounts, [fill]);
    const adj = moveAdjustment(move, 'loans', { id: 'a', date: '2026-10-01', note: 'n', nowIso: 'x' });
    const after = accounts.map(a => (a.id === 'sav' ? { ...a, type: 'loan_given' } : a));
    expect(u(after, [fill, adj])).toBe(before);
    expect(u(after, [fill])).toBe(before - 55000);
  });
});
