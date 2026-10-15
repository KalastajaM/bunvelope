import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { runGenerated } from '../bin/cli-dispatch.mjs';

const ctx = makeCtx({ now: new Date(2026, 8, 15, 12), newId: () => { throw new Error('read only'); } });
const tx = (id, over = {}) => ({ id, type: 'expense', date: '2026-09-05', payee: 'Gym', amount: 30, account: 'a', envelope_id: 'e', status: 'posted', ...over });
const bill = { id: 'bill', kind: 'expense', envelope_id: 'e', description: 'Gym', default_amount: 30,
  include: true, monthly_schedule: { Sep: true }, payment_day: 5, schedule_day_type: 'exact',
  as_schedule: true, as_schedule_since: '2026-09-01', account_id: 'a' };
const data = (over = {}) => ({ accounts: [{ id: 'a', name: 'Bank' }, { id: 'b' }], envelopes: [{ id: 'e', name: 'Fun' }],
  transactions: [], budgetItems: [], envelopeTemplates: [], meta: {}, ...over });
const ask = (d, name, input = {}) => {
  const r = runQuery(registry, d, name, input, ctx);
  expect(r.ok).toBe(true);
  expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  return r.value;
};
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

describe('diagnostic queries', () => {
  it('keeps confidence ordering and dismissal semantics, including transitive groups', () => {
    const transactions = [tx('s1', { from_budget: 'x:2026-09' }), tx('s2', { from_budget: 'x:2026-09' }),
      tx('h', { amount: 40 }), tx('p', { amount: 40, from_budget: 'y:2026-09' }),
      tx('c1', { amount: 5, date: '2026-09-01' }), tx('c2', { amount: 5, date: '2026-09-04' }), tx('c3', { amount: 5, date: '2026-09-07' })];
    const d = data({ transactions, meta: { duplicateDismissed: ['c1|c2'] } });
    const groups = ask(d, 'transactions.duplicates').groups;
    expect(groups.map(g => g.kind)).toEqual(['sameKey', 'postedOverHand', 'plain']);
    expect(groups[2].ids).toEqual(['c1', 'c2', 'c3']);
    d.meta.duplicateDismissed.push('c2|c3');
    expect(ask(d, 'transactions.duplicates').groups).toHaveLength(2);
    expect(ask(d, 'transactions.duplicates', { includeDismissed: true }).groups).toHaveLength(3);
    expect(ask(data({ transactions: [...transactions].reverse() }), 'transactions.duplicates').groups.map(g => g.id)).toEqual(groups.map(g => g.id));
  });

  it('keeps split overlap and transfer-route evidence without pairing different routes', () => {
    const groups = ask(data({ transactions: [
      tx('s', { envelope_id: null, envelope_splits: [{ envelope_id: 'e', amount: 30 }] }), tx('h'),
      tx('t1', { type: 'account_transfer', from_account: 'a', to_account: 'b' }),
      tx('t2', { type: 'account_transfer', from_account: 'a', to_account: 'b' }),
      tx('reverse', { type: 'account_transfer', from_account: 'b', to_account: 'a' }),
    ] }), 'transactions.duplicates').groups;
    expect(groups.map(g => [...g.ids].sort())).toEqual([['h', 's'], ['t1', 't2']]);
    expect(groups[0].rows[0].envelope_splits).toEqual([{ envelope_id: 'e', amount: 30 }]);
  });

  it('uses the query date, supports envelope scoping, and excludes settled or ineligible occurrences', () => {
    const d = data({ transactions: [tx('payment')], budgetItems: [bill] });
    expect(ask(d, 'transactions.unlinked').proposals).toMatchObject([{ key: 'bill:2026-09', txId: 'payment' }]);
    expect(ask(d, 'transactions.unlinked', { envelope: 'e' }).proposals).toHaveLength(1);
    expect(ask(d, 'transactions.unlinked', { date: '2026-09-04' }).proposals).toEqual([]);
    for (const over of [
      { meta: { scheduledTombstones: ['bill:2026-09'] } },
      { transactions: [tx('payment', { from_budget: 'bill:2026-09' })] },
      { envelopes: [{ id: 'e', archived: true }] },
      { accounts: [] },
    ]) expect(ask({ ...d, ...over }, 'transactions.unlinked').proposals).toEqual([]);
  });

  it('reports transfer repairs globally and omits them from envelope-scoped results', () => {
    const d = data({ budgetItems: [{ ...bill, kind: 'account_transfer', to_account_id: 'b' }],
      transactions: [tx('transfer', { type: 'account_transfer', from_account: 'a', to_account: 'b' })] });
    expect(ask(d, 'transactions.unlinked').proposals).toMatchObject([{ txId: 'transfer', fromAccount: 'a', toAccount: 'b' }]);
    expect(ask(d, 'transactions.unlinked', { envelope: 'e' }).proposals).toEqual([]);
  });

  it('keeps neutral categories distinct and counts only posted-over-hand duplicates in the badge', () => {
    const d = data({ accounts: [{ id: 'a' }, { id: 'b', archived: true }], budgetItems: [bill], transactions: [
      tx('payment'), tx('plain1', { amount: 5 }), tx('plain2', { amount: 5 }),
      tx('hand', { amount: 40 }), tx('post', { amount: 40, from_budget: 'x:2026-09' }),
      tx('future', { account: 'b', date: '2026-10-01', amount: 70 }), tx('missing', { account: 'gone', amount: 99 }),
    ] });
    const a = ask(d, 'budget.diagnostics');
    expect(a.groups).toEqual(ask(d, 'transactions.duplicates').groups);
    expect(a.proposals).toEqual(ask(d, 'transactions.unlinked').proposals);
    expect(a.extras).toMatchObject({ unlinked: 1, postedDuplicates: 1, archivedFuture: [{ id: 'future' }] });
    expect(a.report.totalProblems).toBeGreaterThan(0);
    expect(a.totalCount).toBe(a.report.totalProblems + 3);
    expect(ask(d, 'budget.diagnostics', { date: '2026-10-02' }).extras.archivedFuture).toEqual([]);
  });

  it('a reconciliation drift lists the changes since the reconciliation, from the change log', () => {
    const row = tx('r', { cleared: true, date: '2026-09-02', amount: 30 });
    const accounts = [{ id: 'a', name: 'Bank', initialBalance: 100, lastReconciledAt: '2026-09-10',
      lastReconciledBalance: 70, lastReconciledLedger: 70, lastReconciledStamp: '2026-09-11T08:00:00.000Z' }];
    const edited = { ...row, amount: 25 };
    const d = data({ accounts, transactions: [edited], meta: { change_log: [
      { at: '2026-09-12T08:00:00.000Z', op: 'edit', id: 'r', fields: ['amount'], before: row, after: edited },
    ] } });
    const drift = ask(d, 'budget.diagnostics').report.problems.find(p => p.code === 'reconciledDrift');
    expect(drift.params).toMatchObject({ accountId: 'a', gap: 5, timingKnown: true });
    expect(drift.params.changes).toEqual([
      { id: 'r', kind: 'edited', at: '2026-09-12T08:00:00.000Z', date: '2026-09-02', payee: 'Gym', shift: 5, exists: true },
    ]);
  });

  it('never mutates the source or exposes mutable ledger references', () => {
    const d = freeze(data({ transactions: [tx('a'), tx('b')] }));
    const before = JSON.stringify(d);
    const a = ask(d, 'budget.diagnostics');
    a.groups[0].rows[0].payee = 'Changed';
    expect(JSON.stringify(d)).toBe(before);
  });

  it('generates CLI queries with the same answers and no dispatch', async () => {
    const d = data({ transactions: [tx('payment')], budgetItems: [bill] });
    const session = { query: (name, input) => runQuery(registry, d, name, input, ctx) };
    for (const [verb, name] of [['transactions unlinked', 'transactions.unlinked'], ['transactions duplicates', 'transactions.duplicates'], ['budget diagnostics', 'budget.diagnostics']]) {
      const args = [...verb.split(' '), '--file', 'scratch.json'];
      if (name === 'transactions.unlinked') args.push('--envelope', 'Fun');
      const result = await runGenerated({ registry, args, openSession: () => session });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).value).toEqual(ask(d, name));
    }
  });
});
