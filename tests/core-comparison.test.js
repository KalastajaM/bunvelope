import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { comparisonSources, comparisonMetaSources } from '../js/core/comparison-sources.js';

const clock = (day = 7, month = 9) => makeCtx({ now: new Date(2026, month, day, 12), newId: () => 'new' });
const every = Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, true]));
const budget = () => ({ meta: { country: 'FI', currency: 'EUR' },
  accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food' }], budgetItems: [], envelopeTemplates: [], transactions: [],
});
const expense = (extra = {}) => ({ id: 'shop', date: '2026-10-07', type: 'expense', amount: 100, account: 'bank', envelope_id: 'food', payee: 'Shop', status: 'posted', ...extra });
function save(d, view = {}, ctx = clock()) {
  const r = runCommand(registry, d, 'comparison.save', view, ctx);
  expect(r.ok).toBe(true);
  return r.value.after;
}
function explain(d, input = {}, ctx = clock()) {
  const r = runQuery(registry, d, 'comparison.explain', input, ctx);
  expect(r.ok).toBe(true);
  return r.value;
}
describe('saved number comparison', () => {
  it.each(['account', 'envelope'])('preserves a signed %s adjustment in historical record amounts', target => {
    const before = budget(), after = budget();
    after.transactions = [{ id: 'adjust', type: 'adjustment', target, target_id: target === 'account' ? 'bank' : 'food', amount: -123.45 }];
    const source = comparisonSources('transactions', before, after)[0];
    expect(source.amount.after).toBe(-123.45);
    expect(source.details).toContainEqual({ path: ['amount'], before: null, after: -123.45, format: 'money' });
    expect(source.details).toContainEqual({ path: ['target_id'], before: null, after: target === 'account' ? 'Bank' : 'Food', format: 'text' });
  });
  it('keeps price precision and quote currencies in historical investment details', () => {
    const before = budget(), after = budget();
    before.meta.investments = { prices: { ABC: { price: 1.001, fx: { price: 1.201, currency: 'USD' } } } };
    after.meta.investments = { prices: { ABC: { price: 1.004, fx: { price: 1.204, currency: 'USD' } } } };
    const source = comparisonMetaSources('investments', ['investments'], before, after)[0];
    expect(source.details).toContainEqual({ path: ['prices', 'ABC', 'price'], before: 1.001, after: 1.004, format: 'price', beforeCurrency: 'EUR', afterCurrency: 'EUR' });
    expect(source.details).toContainEqual({ path: ['prices', 'ABC', 'fx', 'price'], before: 1.201, after: 1.204, format: 'price', beforeCurrency: 'USD', afterCurrency: 'USD' });
  });
  it('requires an explicit first save and never pretends to reconstruct earlier history', () => {
    expect(explain(budget())).toEqual({ status: 'missing' });
  });
  it('keeps an independent single copy, excludes unrelated metadata and does not alter money', () => {
    const d = budget(); d.meta.aiConsent = { private: true }; d.meta.change_log = [1];
    const original = structuredClone(d);
    const saved = save(d);
    expect(d).toEqual(original);
    expect(saved.meta.comparisonPoint.data.meta).not.toHaveProperty('aiConsent');
    expect(saved.meta.comparisonPoint.data.meta).not.toHaveProperty('change_log');
    saved.accounts[0].initialBalance = 2000;
    expect(saved.meta.comparisonPoint.data.accounts[0].initialBalance).toBe(1000);
    const again = save(saved);
    expect(again.meta.comparisonPoint.data.meta).not.toHaveProperty('comparisonPoint');
    expect(explain(again)).toMatchObject({ status: 'ready', before: 2000, after: 2000, delta: 0, steps: [] });
  });
  it('attributes account and transaction changes to a bridge that reconciles', () => {
    const d = save(budget());
    d.accounts = [{ ...d.accounts[0], initialBalance: 1500 }];
    d.transactions = [expense({ amount: 200 })];
    const before = structuredClone(d);
    const r = explain(d);
    expect(r).toMatchObject({ before: 1000, after: 1300, delta: 300 });
    expect(r.steps.map(s => [s.group, s.delta])).toEqual([['accounts', 500], ['transactions', -200]]);
    expect(r.steps[1].sources).toMatchObject([{ id: 'shop', name: 'Shop', date: '2026-10-07', kind: 'added', amount: { label: 'transactionAmount', before: null, after: -200 } }]);
    expect(d).toEqual(before);
  });
  it('explains edits and deletions without depending on the capped transaction change log', () => {
    let d = budget(); d.transactions = [expense(), expense({ id: 'other', amount: 50 })];
    d = save(d); d.transactions = [expense({ amount: 80 })];
    const r = explain(d);
    expect(r).toMatchObject({ before: 850, after: 920, delta: 70 });
    expect(r.steps[0].sources.map(s => s.kind)).toEqual(['edited', 'removed']);
    expect(r.steps[0].sources[0].amount).toEqual({ label: 'transactionAmount', before: -100, after: -80 });
    expect(r.steps[0].sources[1].amount).toEqual({ label: 'transactionAmount', before: -50, after: null });
    expect(r.steps[0].sources[1].details).toContainEqual({ path: ['account'], before: 'Bank', after: null, format: 'text' });
  });
  it('separates balance-view changes from actual ledger edits', () => {
    const d = budget(); d.transactions = [expense({ date: '2026-11-01' })];
    const r = explain(save(d), { lens: 'today' });
    expect(r).toMatchObject({ before: 900, after: 1000, delta: 100 });
    expect(r.steps.map(s => [s.group, s.delta])).toEqual([['view', 100]]);
  });
  it('attributes a future cleared transaction entering Today to time, including month boundaries', () => {
    const d = budget(); d.transactions = [expense({ date: '2026-11-01', cleared: true })];
    const r = explain(save(d, { lens: 'today' }, clock(31)), { lens: 'today' }, clock(1, 10));
    expect(r).toMatchObject({ before: 1000, after: 900, delta: -100 });
    expect(r.steps.map(s => [s.group, s.delta])).toEqual([['date', -100]]);
  });
  it('explains actual spare using the same 12-month projection as an envelope card', () => {
    const d = budget();
    d.transactions = [{ id: 'fill', date: '2026-10-01', type: 'fill', status: 'posted', lines: [{ envelope_id: 'food', mode: 'add', amount: 500 }] }];
    const saved = save(d); saved.transactions = [...saved.transactions, expense()];
    const r = explain(saved, { metric: 'spare', envelope: 'food' });
    expect(r).toMatchObject({ status: 'ready', before: 500, after: 400, delta: -100 });
    expect(r.steps[0].delta).toBe(-100);
  });
  it('does not invent zero when an envelope was added, removed or archived', () => {
    const d = save(budget()); d.envelopes = [];
    expect(explain(d, { metric: 'spare', envelope: 'food' })).toMatchObject({ status: 'unavailable', reason: 'metric' });
    d.envelopes = [{ id: 'new' }];
    expect(explain(d, { metric: 'spare', envelope: 'new' })).toMatchObject({ status: 'unavailable' });
  });
  it('accounts for plan changes and matches the twelve points shown in Overview', () => {
    const d = save(budget());
    d.budgetItems = [{ id: 'bill', kind: 'expense', description: 'Bill', default_amount: -10, include: true, as_schedule: true, account_id: 'bank', envelope_id: 'food', payment_day: 15, monthly_schedule: every }];
    const r = explain(d, { metric: 'forecast' });
    expect(r.status).toBe('ready');
    expect(r.before).toBe(1000);
    expect(r.after).toBeLessThan(900);
    expect(r.steps.map(s => s.group)).toEqual(['budgetItems']);
    expect(r.steps.reduce((n, s) => n + s.delta, r.before)).toBeCloseTo(r.after, 2);
    const current = runQuery(registry, d, 'forecast.simulation', { months: 12, alerts: false }, clock());
    expect(r.after).toBe(current.value.points.slice(0, 12).at(-1).total);
  });
  it('shows price changes in unrealized gains, without claiming they changed account-based net worth', () => {
    const d = budget(); d.accounts.push({ id: 'broker', name: 'Broker', type: 'investment', trackHoldings: true });
    d.transactions = [{ id: 'buy', type: 'investment_transfer', direction: 'buy', date: '2026-10-01', amount: 100, units: 10, symbol: 'ABC', from_account: 'bank', to_account: 'broker', status: 'posted' }];
    d.meta.investments = { prices: { ABC: { price: 12 } } };
    const saved = save(d); saved.meta.investments = { prices: { ABC: { price: 15 } } };
    const r = explain(saved, { metric: 'unrealized' });
    expect(r).toMatchObject({ status: 'ready', before: 20, after: 50, delta: 30 });
    expect(r.steps.map(s => [s.group, s.delta])).toEqual([['investments', 30]]);
    expect(explain(saved).delta).toBe(0);
  });
  it('refuses incompatible currency, corrupt snapshots, invalid horizons and missing envelope inputs', () => {
    const d = save(budget()); d.meta.currency = 'USD';
    expect(explain(d)).toMatchObject({ status: 'unavailable', reason: 'currency' });
    d.meta.comparisonPoint.version = 99;
    expect(runQuery(registry, d, 'comparison.explain', {}, clock()).ok).toBe(false);
    expect(runCommand(registry, budget(), 'comparison.save', { horizon: '3m' }, clock()).ok).toBe(false);
    expect(runQuery(registry, save(budget()), 'comparison.explain', { metric: 'spare' }, clock()).ok).toBe(false);
  });
  it('clears the point without changing the ledger or other metadata', () => {
    const d = save(budget());
    const r = runCommand(registry, d, 'comparison.clear', {}, clock());
    expect(r.ok).toBe(true);
    expect(r.value.after.meta).toEqual({ country: 'FI', currency: 'EUR' });
    expect(r.value.after.transactions).toBe(d.transactions);
    expect(explain(r.value.after)).toEqual({ status: 'missing' });
  });
});
