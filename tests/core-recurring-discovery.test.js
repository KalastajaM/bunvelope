import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { shiftRecurringDate } from '../js/core/recurring-discovery.js';
const ctx = makeCtx({ now: new Date(2026, 9, 7, 12), newId: () => 'new' });
const dates = ['2026-07-31', '2026-08-31', '2026-09-30'];
const data = (ds = dates) => ({ meta: {}, accounts: [{ id: 'bank', name: 'Bank', type: 'checking' }], envelopes: [], envelopeTemplates: [], budgetItems: [],
  transactions: ds.map((date, i) => ({ id: String(i), date, type: 'expense', amount: -10, payee: 'Music', account: 'bank', status: 'posted' })) });
function query(d) { const r = runQuery(registry, d, 'recurring.suggestions', {}, ctx); expect(r.ok).toBe(true); return r.value.suggestions; }
function command(d, action, extra = {}, key = query(d)[0]?.key) { return runCommand(registry, d, 'recurring.reviewSuggestion', { key, action, ...extra }, ctx); }
describe('manual recurring discovery', () => {
  it('detects month-end payments without mutating history', () => {
    const d = data(); const before = structuredClone(d);
    expect(query(d)[0]).toMatchObject({ period: 1, amount: 10, annual: 120, monthly: 10, firstDate: '2026-10-30', count: 3, status: 'pending' });
    expect(d).toEqual(before);
  });
  it.each([[['2026-03-15','2026-06-15','2026-09-15'],3,40], [['2025-09-15','2026-09-15'],12,10]])('detects quarterly and annual history', (ds, period, annual) => {
    expect(query(data(ds))[0]).toMatchObject({ period, annual });
  });
  it('requires sufficient evidence and ignores expired or irregular patterns', () => {
    expect(query(data(dates.slice(1)))).toEqual([]);
    expect(query(data(['2025-07-01','2025-08-01','2025-09-01']))).toEqual([]);
    expect(query(data(['2026-07-01','2026-08-01','2026-09-20']))).toEqual([]);
    const d = data(); d.transactions[1].amount = -50; expect(query(d)).toEqual([]);
  });
  it.each([{ type: 'income' }, { type: 'transfer' }, { status: 'scheduled' }, { is_forecast: true }, { reverses: 'x' }, { reversed_by: 'x' }, { from_budget: 'item:2026-07' }, { date: '2027-01-01' }])('excludes non-manual actual expenses %j', fields => {
    const d = data(); Object.assign(d.transactions[0], fields); expect(query(d)).toEqual([]);
  });
  it('does not combine accounts, duplicate imports or ambiguous frequent merchant purchases', () => {
    const d = data(); d.transactions[0].account = 'other'; expect(query(d)).toEqual([]);
    const dup = data(dates.slice(1)); dup.transactions.push({ ...dup.transactions[0], id: 'dup' }); expect(query(dup)).toEqual([]);
    const grocery = data(); grocery.transactions.push({ ...grocery.transactions[1], id: 'extra', date: '2026-09-15' }); expect(query(grocery)).toEqual([]);
  });
  it('resolves explicit aliases and suppresses an existing hidden schedule', () => {
    const d = data(); d.transactions[0].payee = 'OLD MUSIC'; d.meta.payeeAliases = { 'old music': 'Music' };
    expect(query(d)).toHaveLength(1);
    d.budgetItems.push({ id: 'known', description: 'Music', account_id: 'bank', as_schedule: true, recurring_review: { hidden: true } });
    expect(query(d)).toEqual([]);
  });
  it('dismisses and restores persistently, without touching transactions', () => {
    const d = data(); const dismissed = command(d, 'dismiss'); expect(dismissed.ok).toBe(true);
    const after = dismissed.value.after; expect(query(after)[0].status).toBe('dismissed'); expect(after.transactions).toEqual(d.transactions);
    expect(command(after, 'create', { firstDate: '2026-11-01' }).ok).toBe(false);
    const restored = command(after, 'restore'); expect(restored.ok).toBe(true); expect(query(restored.value.after)[0].status).toBe('pending');
  });
  it('links without a new schedule and resurfaces after the schedule is removed', () => {
    const d = data(); d.budgetItems.push({ id: 'different', description: 'Entertainment', as_schedule: true, kind: 'expense' });
    const linked = command(d, 'link', { itemId: 'different' }); expect(linked.ok).toBe(true);
    expect(query(linked.value.after)[0].status).toBe('linked'); expect(linked.value.after.budgetItems).toEqual(d.budgetItems);
    linked.value.after.budgetItems = []; expect(query(linked.value.after)[0].status).toBe('pending');
  });
  it('creates exactly one future schedule atomically and leaves ledger history unchanged', () => {
    const d = data(['2026-03-15','2026-06-15','2026-09-15']); const key = query(d)[0].key;
    expect(command(d, 'create', { firstDate: '2026-10-07' }).ok).toBe(false);
    const result = command(d, 'create', { firstDate: '2026-12-15' }); expect(result.ok).toBe(true);
    const after = result.value.after;
    expect(after.budgetItems).toHaveLength(1);
    expect(after.budgetItems[0]).toMatchObject({ default_amount: -10, as_schedule: true, start_month: '2026-12', payment_day: 15, account_id: 'bank', monthly_schedule: { Jan: false, Mar: true, Jun: true, Sep: true, Dec: true } });
    expect(after.transactions).toEqual(d.transactions); expect(query(after)[0].status).toBe('linked');
    expect(command(after, 'create', { firstDate: '2026-12-15' }, key).ok).toBe(false);
    const costs = runQuery(registry, after, 'recurring.costs', {}, ctx); expect(costs.value.items[0].next.date).toBe('2026-12-15');
  });
  it('clamps leap dates and calendar month ends consistently', () => {
    expect(shiftRecurringDate('2024-02-29',12)).toBe('2025-02-28');
    expect(shiftRecurringDate('2026-01-31',1)).toBe('2026-02-28');
    expect(shiftRecurringDate('2026-03-29',1)).toBe('2026-04-29');
  });
});

it('recognizes a known schedule through its posted payee even when its title differs', () => {
  const d = data();
  d.budgetItems.push({ id: 'known', description: 'Entertainment', account_id: 'bank', as_schedule: true });
  d.transactions.push({ ...d.transactions[0], id: 'scheduled', from_budget: 'known:2026-07' });
  expect(query(d)).toEqual([]);
});

describe('variable bills and price reviews', () => {
  const prices = d => runQuery(registry, d, 'recurring.suggestions', {}, ctx).value.priceIncreases;
  it('requires four variable monthly bills and estimates their average, with a range', () => {
    const d = data(['2026-06-01','2026-07-01','2026-08-01','2026-09-01']);
    [40,80,50,70].forEach((amount,i) => { d.transactions[i].amount = amount; });
    expect(query(d)[0]).toMatchObject({ variable: true, amount: 60, annual: 720, minAmount: 40, maxAmount: 80 });
    expect(prices(d)).toEqual([]);
    d.transactions.shift(); expect(query(d)).toEqual([]);
  });
  it('detects variable quarterly and yearly bills only with the extra cycle', () => {
    for (const ds of [['2025-12-01','2026-03-01','2026-06-01','2026-09-01'], ['2024-09-01','2025-09-01','2026-09-01']]) {
      const d = data(ds); [50,100,70,120].forEach((amount,i) => { if(d.transactions[i]) d.transactions[i].amount = amount; });
      expect(query(d)[0].variable).toBe(true); d.transactions.shift(); expect(query(d)).toEqual([]);
    }
  });
  it('shows an increase for tracked posted payments, respecting hidden items and dismiss/restore', () => {
    const d = data(); d.transactions[2].amount = 12;
    d.budgetItems.push({ id: 'known', description: 'Music', as_schedule: true, account_id: 'bank' });
    d.transactions.forEach((tx,i) => { tx.from_budget = `known:2026-0${i+7}`; });
    const alert = prices(d)[0]; expect(alert).toMatchObject({ extraAnnual: 24, trackedItemId: 'known', increase: { previous: 10, current: 12 } });
    const r = runCommand(registry, d, 'recurring.reviewPrice', { key: alert.key, dismissed: true }, ctx);
    expect(r.ok).toBe(true); expect(prices(r.value.after)[0].dismissed).toBe(true);
    expect(r.value.after.transactions).toEqual(d.transactions); expect(r.value.after.budgetItems).toEqual(d.budgetItems);
    const restored = runCommand(registry, r.value.after, 'recurring.reviewPrice', { key: alert.key, dismissed: false }, ctx);
    expect(prices(restored.value.after)[0].dismissed).toBe(false);
    d.budgetItems[0].recurring_review = { hidden: true }; expect(prices(d)).toEqual([]);
  });
  it('keeps the same alert key during a higher-price plateau and surfaces a later increase', () => {
    const d = data(['2026-04-01','2026-05-01','2026-06-01']); d.transactions[2].amount = 12;
    // Use a current as-of so the June pattern is fresh.
    const read = date => runQuery(registry, d, 'recurring.suggestions', { date }, ctx).value.priceIncreases;
    const original = read('2026-06-02')[0].key;
    d.transactions.push({ ...d.transactions[2], id:'july', date:'2026-07-01' });
    expect(read('2026-07-02')[0].key).toBe(original);
    d.transactions.push({ ...d.transactions[2], id:'aug', date:'2026-08-01', amount:15 });
    expect(read('2026-08-02')[0].key).not.toBe(original);
  });
  it('does not flag decreases, minor rounding, or unstable preceding prices', () => {
    for (const amounts of [[10,10,9], [10,10,10.1], [10,8,12]]) {
      const d = data(); amounts.forEach((amount,i) => { d.transactions[i].amount = amount; }); expect(prices(d)).toEqual([]);
    }
  });
  it('creates a variable bill with the user-reviewed amount, without changing past payments', () => {
    const d = data(['2026-06-01','2026-07-01','2026-08-01','2026-09-01']);
    [40,80,50,70].forEach((amount,i) => { d.transactions[i].amount = amount; });
    const r = command(d, 'create', { firstDate: '2026-11-01', amount: 75 });
    expect(r.ok).toBe(true); expect(r.value.after.budgetItems[0].default_amount).toBe(-75); expect(r.value.after.transactions).toEqual(d.transactions);
  });
});

it('suppresses alerts for hidden schedules recognized through older posted payees', () => {
  const d = data(); d.transactions[2].amount = 12;
  d.budgetItems.push({ id:'known', description:'Entertainment', account_id:'bank', as_schedule:true, recurring_review:{hidden:true} });
  d.transactions.push({ ...d.transactions[0], date:'2020-01-01', id:'old', from_budget:'known:2020-01' });
  expect(runQuery(registry,d,'recurring.suggestions',{},ctx).value.priceIncreases).toEqual([]);
});
