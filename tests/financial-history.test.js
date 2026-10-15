import { describe, it, expect } from 'vitest';
import { appendFinancialHistory, historyPoint, initialHistory } from '../js/core/financial-history.js';
import { runQuery } from '../js/core/pipeline.js';
import { registry } from '../js/core/index.js';
import { makeCtx } from '../js/core/context.js';
const date = day => new Date(2026, 9, day, 12);
const budget = () => ({ accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }], envelopes: [{ id: 'food', name: 'Food' }],
  transactions: [], budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8, country: 'FI' } });
const tx = amount => ({ id: 'x', type: 'expense', amount, date: '2026-10-01', account: 'bank', envelope_id: 'food', status: 'posted', payee: 'Backdated bill' });
const commit = (d, changes, day) => {
  const after = { ...d, ...changes };
  return JSON.parse(JSON.stringify({ ...after, meta: { ...after.meta, financialHistory: appendFinancialHistory(d, after, date(day)) } }));
};
const explain = (d, selected, today = 10) => runQuery(registry, d, 'comparison.explain', { date: selected, lens: 'booked' }, makeCtx({ now: date(today), newId: () => 'unused' }));

describe('automatic financial history', () => {
  it('reconstructs the start of a chosen day across backdated additions, edits and deletions after serialization', () => {
    let d = commit(budget(), {}, 7);
    d = commit(d, { transactions: [tx(100)] }, 8);
    d = commit(d, { transactions: [tx(150)] }, 9);
    d = commit(d, { transactions: [] }, 10);
    expect(d.meta.financialHistory.entries).toHaveLength(3);
    expect(explain(d, '2026-10-09').value).toMatchObject({ status: 'ready', before: 900, after: 1000, delta: 100, partialDay: false, revisions: 2 });
    expect(explain(d, '2026-10-10').value).toMatchObject({ before: 850, after: 1000, delta: 150 });
    expect(explain(d, '2026-10-07').value).toMatchObject({ before: 1000, partialDay: true });
    expect(explain(d, '2026-10-06').value).toMatchObject({ status: 'unavailable', reason: 'history' });
    expect(explain(d, '2026-10-11').ok).toBe(false);
  });
  it('records all calculation collections and financial settings, including investment prices and Undo-like reversals', () => {
    let d = commit(budget(), {}, 7);
    const before = structuredClone(d);
    const changes = { accounts: [{ ...d.accounts[0], initialBalance: 2000 }], envelopes: [{ ...d.envelopes[0], goal_amount: 100 }],
      budgetItems: [{ id: 'plan', kind: 'expense', default_amount: -50 }], envelopeTemplates: [{ id: 'tpl', name: 'Monthly', lines: [] }],
      meta: { ...d.meta, investments: { prices: { ABC: 25 } }, scheduledTombstones: ['plan:2026-10'] } };
    d = commit(d, changes, 8);
    const restored = historyPoint(d, '2026-10-08').data;
    expect(restored.accounts).toEqual(before.accounts); expect(restored.budgetItems).toEqual([]);
    expect(restored.meta.investments).toEqual({}); expect(restored.meta.scheduledTombstones).toEqual([]);
    expect(Object.keys(d.meta.financialHistory.entries[0].diff).sort()).toEqual(['accounts','budgetItems','envelopeTemplates','envelopes','meta']);
    d = commit(d, { ...before, meta: { ...before.meta, financialHistory: d.meta.financialHistory } }, 9);
    expect(d.meta.financialHistory.entries).toHaveLength(2);
    expect(explain(d, '2026-10-09').value).toMatchObject({ before: 2000, after: 1000 });
  });
  it('retains earlier captured periods but refuses unknown dates across an external-edit gap', () => {
    let d = commit(budget(), {}, 7); d = commit(d, { transactions: [tx(100)] }, 8);
    d = { ...d, accounts: [{ ...d.accounts[0], initialBalance: 3000 }] };
    expect(historyPoint(d, '2026-10-08')).toBeNull();
    d = commit(d, {}, 10);
    expect(d.meta.financialHistory.gap).toBe(true);
    expect(explain(d, '2026-10-08').value).toMatchObject({ status: 'ready', before: 1000, after: 2900 });
    expect(explain(d, '2026-10-09').value).toMatchObject({ status: 'unavailable', reason: 'history' });
  });
  it('does not recursively capture history, legacy snapshots, changelog or private metadata', () => {
    const d = budget(); d.meta.change_log = [1]; d.meta.comparisonPoint = { secret: 1 }; d.meta.aiConsent = { secret: 2 };
    const h = initialHistory(d, date(7));
    expect(h.head.meta).not.toHaveProperty('financialHistory'); expect(h.head.meta).not.toHaveProperty('comparisonPoint');
    expect(h.head.meta).not.toHaveProperty('change_log'); expect(h.head.meta).not.toHaveProperty('aiConsent');
  });
  it('owns its snapshots and revision rows even when callers later mutate their inputs', () => {
    const before = budget();
    before.transactions = [tx(100)];
    before.meta.financialHistory = initialHistory(before, date(7));
    const after = { ...before, transactions: [{ ...before.transactions[0], amount: 150 }],
      meta: { ...before.meta, investments: { prices: { ABC: { price: 20 } } } } };
    const history = appendFinancialHistory(before, after, date(8));
    before.transactions[0].amount = 999;
    after.transactions[0].amount = 888;
    after.meta.investments.prices.ABC.price = 777;
    expect(history.head.transactions[0].amount).toBe(150);
    expect(history.head.meta.investments.prices.ABC.price).toBe(20);
    expect(history.entries[0].diff.transactions.changed[0]).toMatchObject({
      before: { amount: 100 }, after: { amount: 150 },
    });
    expect(history.entries[0].diff.meta.changed.find(c => c.key === 'investments').after.prices.ABC.price).toBe(20);
    expect(before.meta.financialHistory.head.transactions[0].amount).toBe(100);
  });
  it('keeps reorder history and leaves caller arrays untouched', () => {
    const before = budget();
    before.accounts.push({ id: 'savings', name: 'Savings', type: 'savings', initialBalance: 20 });
    before.meta.financialHistory = initialHistory(before, date(7));
    const after = { ...before, accounts: [...before.accounts].reverse() };
    const history = appendFinancialHistory(before, after, date(8));
    const saved = JSON.parse(JSON.stringify({ ...after, meta: { ...after.meta, financialHistory: history } }));
    expect(historyPoint(saved, '2026-10-08').data.accounts.map(a => a.id)).toEqual(['bank', 'savings']);
    expect(before.accounts.map(a => a.id)).toEqual(['bank', 'savings']);
    expect(after.accounts.map(a => a.id)).toEqual(['savings', 'bank']);
  });
  it('rejects corrupted revision data without inventing a historical balance', () => {
    let d = commit(budget(), {}, 7); d = commit(d, { transactions: [tx(100)] }, 8);
    d.meta.financialHistory.entries[0].diff.transactions = { broken: true };
    expect(historyPoint(d, '2026-10-08')).toBeNull();
    expect(explain(d, '2026-10-08').value.status).toBe('unavailable');
  });
  it('keeps history beyond the old 1,000-entry transaction log cap', () => {
    let d = commit(budget(), {}, 7);
    for (let i = 1; i <= 1001; i++) d = commit(d, { accounts: [{ ...d.accounts[0], initialBalance: 1000 + i }] }, 8);
    expect(d.meta.financialHistory.entries).toHaveLength(1001);
    expect(explain(d, '2026-10-08').value).toMatchObject({ before: 1000, after: 2001, delta: 1001 });
  });
});
