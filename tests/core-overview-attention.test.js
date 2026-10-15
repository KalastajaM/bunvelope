import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

const newId = vi.fn();
const ctx = makeCtx({ now: new Date(2026, 9, 7, 12), newId });
const fill = (id, amount) => ({ id: 'fill:' + id, type: 'fill', date: '2026-10-01', status: 'posted', lines: [{ envelope_id: id, mode: 'add', amount }] });
const expense = (date, amount) => ({ id: date, type: 'expense', account: 'bank', envelope_id: 'food', date, amount, status: 'scheduled' });
const budget = () => ({ meta: { schemaVersion: 8, country: 'FI' }, accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 100 }],
  envelopes: [{ id: 'food', name: 'Food' }], transactions: [fill('food', 100)], budgetItems: [], envelopeTemplates: [] });
const query = (data, input = {}, clock = ctx) => {
  const r = runQuery(registry, data, 'overview.attention', input, clock);
  expect(r.ok, JSON.stringify(r)).toBe(true); return r.value;
};

describe('Overview attention', () => {
  it('is read-only and detects a daily cash dip even when month-end recovers', () => {
    const d = budget(); d.transactions.push(expense('2026-10-10', 150), { id: 'salary', type: 'income', account: 'bank', amount: 300, date: '2026-10-25', status: 'scheduled' });
    const original = structuredClone(d); newId.mockClear();
    const r = query(d);
    expect(r.items[0]).toMatchObject({ key: 'account:bank', date: '2026-10-10', balance: -50 });
    expect(r.items[1]).toMatchObject({ key: 'envelope:food', date: '2026-10-10', gap: 50 });
    expect(d).toEqual(original); expect(newId).not.toHaveBeenCalled();
  });
  it('shows the first reserve breach separately from the largest gap and its date', () => {
    const d = budget(); d.accounts[0].initialBalance = 1000;
    d.budgetItems = [{ id: 'buffer', envelope_id: 'food', kind: 'expense', include: true, default_amount: 0, extra_buffer: 20 }];
    d.transactions.push(expense('2026-10-10', 90), expense('2026-11-10', 20));
    expect(query(d).items).toEqual([expect.objectContaining({ kind: 'envelope', date: '2026-10-10', balance: 10, floor: 20, gap: 30, low: { date: '2026-11-10', balance: -10 } })]);
  });
  it('orders dated goals with shortfalls, showing overdue and undated goals explicitly', () => {
    const d = budget(); d.envelopes = [
      { id: 'food', name: 'Food', goal_amount: 200, goal_date: '2026-10-15' },
      { id: 'late', name: 'Late', goal_amount: 30, goal_date: '2026-09-01' },
      { id: 'someday', name: 'Someday', goal_amount: 50 },
      { id: 'far', name: 'Far', goal_amount: 100, goal_date: '2028-01-01' },
    ];
    const r = query(d);
    expect(r.items.map(i => i.key)).toEqual(['goal:late', 'goal:food', 'goal:someday']);
    expect(r.items[0]).toMatchObject({ date: '2026-10-07', deadline: '2026-09-01', overdue: true, gap: 30 });
    expect(r.items[1]).toMatchObject({ date: '2026-10-15', target: 200, projected: 100, gap: 100 });
    expect(r.items[2]).toMatchObject({ date: r.end, deadline: null });
    expect(r.incomplete).toEqual([{ kind: 'goal', id: 'far', name: 'Far', date: '2028-01-01' }]);
  });
  it('ignores archived entities, achieved goals and credit-card debt as cash deficits', () => {
    const d = budget(); d.envelopes[0].goal_amount = 90;
    d.envelopes.push({ id: 'old', name: 'Old', archived: true, goal_amount: 500 });
    d.accounts.push({ id: 'old-bank', type: 'bank', initialBalance: -500, archived: true }, { id: 'card', name: 'Card', type: 'credit_card', initialBalance: -500 });
    const r = query(d);
    expect(r.items).toEqual([]); expect(r.incomplete).toEqual([{ kind: 'card', id: 'card', name: 'Card' }]);
  });
  it('tracks savings cash shortfalls and assesses a known goal on its deadline', () => {
    const d = budget(); d.accounts[0].type = 'savings';
    d.envelopes[0] = { ...d.envelopes[0], goal_amount: 80, goal_date: '2026-10-09' };
    d.transactions.push(expense('2026-10-10', 150));
    expect(query(d).items.map(i => i.kind)).toEqual(['account', 'envelope']);
  });
  it('uses the requested date and clamps the leap-day horizon even without envelopes', () => {
    for (const envelopes of [[], budget().envelopes]) {
      const d = budget(); d.envelopes = envelopes;
      const r = query(d, { date: '2028-02-29' });
      expect(r.start).toBe('2028-02-29'); expect(r.end).toBe('2029-02-27');
    }
  });
  it('does not treat over-allocation as a duplicate cash or envelope warning', () => {
    const d = budget(); d.transactions = [fill('food', 200)];
    expect(query(d).items).toEqual([]);
  });
});
