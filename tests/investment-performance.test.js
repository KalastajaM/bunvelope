import { describe, it, expect } from 'vitest';
import { investmentPerformance, modifiedDietz } from '../js/engine/investment-performance.js';
import { registry } from '../js/core/index.js';
import { runQuery, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

const input = { from: '2026-01-01', to: '2026-01-31', accountIds: ['broker'] };
const trade = (date, direction, units, amount, extra = {}) => ({
  id: `${date}-${direction}`, type: 'investment_transfer', symbol: 'ABC', date, direction, units, amount, posted: true,
  ...(direction === 'buy' ? { from_account: 'bank', to_account: 'broker' } : { from_account: 'broker', to_account: 'bank' }), ...extra,
});
const fixture = () => ({
  accounts: [{ id: 'broker', name: 'Broker', type: 'investment', archived: true }, { id: 'bank', name: 'Bank', type: 'bank' }],
  envelopes: [], budgetItems: [], envelopeTemplates: [],
  transactions: [trade('2025-12-01', 'buy', 10, 100)],
  meta: { schemaVersion: 8, investments: { priceHistory: { ABC: [{ date: '2025-12-31', price: 10 }, { date: '2026-01-31', price: 12 }] } } },
});
const ctx = makeCtx({ now: new Date(2026, 1, 2, 12), newId: () => 'id' });
const calculate = d => investmentPerformance(d, input);

describe('personal securities return', () => {
  it('separates gain from contributions and weights actual cash-flow timing', () => {
    const d = fixture();
    d.transactions.push(trade('2026-01-16', 'buy', 10, 100));
    const r = calculate(d);
    expect(r.complete).toBe(true);
    expect(r).toMatchObject({ openingValue: 100, closingValue: 240, contributions: 100, gain: 40, returnPct: 26.96 });
    // Capital: 100 + 100 * 15/31 = 148.387...; 40 / capital = 26.9565%.
    const early = modifiedDietz(100, 240, [{ date: '2026-01-01', amount: 100 }], input.from, input.to);
    const late = modifiedDietz(100, 240, [{ date: '2026-01-31', amount: 100 }], input.from, input.to);
    expect(early.returnPct).toBeCloseTo(20.32786885);
    expect(late.returnPct).toBe(40);
  });
  it('counts sale proceeds and dividends and includes fees exactly once', () => {
    const d = fixture();
    d.transactions.push(trade('2026-01-31', 'sell', 5, 58, { fee: 2 }), trade('2026-01-31', 'dividend', undefined, 5));
    expect(calculate(d)).toMatchObject({ closingValue: 60, withdrawals: 58, dividends: 5, gain: 23, returnPct: 23 });
    d.transactions.push(trade('2026-01-31', 'buy', 1, 13, { fee: 1 }));
    expect(calculate(d)).toMatchObject({ gain: 22, returnPct: 22 });
  });
  it('never backfills from a future price or substitutes cost basis', () => {
    const d = fixture();
    d.meta.investments.priceHistory.ABC = [];
    d.meta.investments.prices = { ABC: { price: 12, asOf: '2026-02-01' } };
    expect(calculate(d)).toMatchObject({ complete: false, openingValue: null, closingValue: null, gain: null, returnPct: null });
    expect(calculate(d).issues.filter(i => i.code === 'missing_price')).toHaveLength(2);
  });
  it('accepts a zero closing quote and reports a complete loss', () => {
    const d = fixture(); d.meta.investments.priceHistory.ABC[1].price = 0;
    expect(calculate(d)).toMatchObject({ complete: true, gain: -100, returnPct: -100 });
  });
  it('reveals carried quote dates and rejects stale boundary prices', () => {
    const d = fixture(); d.meta.investments.priceHistory.ABC[1].date = '2026-01-24';
    expect(calculate(d)).toMatchObject({ complete: true });
    expect(calculate(d).holdings[0].closing.priceDate).toBe('2026-01-24');
    d.meta.investments.priceHistory.ABC[1].date = '2026-01-23';
    expect(calculate(d).issues).toContainEqual(expect.objectContaining({ code: 'stale_price', blocking: true }));
    expect(investmentPerformance(fixture(), { ...input, maxPriceAgeDays: 0 }).complete).toBe(true);
  });
  it('ignores scheduled, forecast, future and unrelated-account trades', () => {
    const d = fixture(); const before = calculate(d);
    d.transactions.push(trade('2026-01-15', 'buy', 100, 1000, { posted: false }), trade('2026-01-15', 'buy', 100, 1000, { is_forecast: true }), trade('2026-02-01', 'buy', 100, 1000), trade('2026-01-15', 'buy', 100, 1000, { to_account: 'other' }));
    expect(calculate(d)).toEqual(before);
  });
  it.each([
    ['missing_units', { units: undefined }], ['missing_symbol', { symbol: '' }],
    ['invalid_cash', { amount: undefined }], ['invalid_cash', { amount: Infinity }], ['invalid_date', { date: '2026-02-30' }],
    ['oversold_units', { direction: 'sell', from_account: 'broker', units: 100 }],
  ])('blocks incomplete or inconsistent trades: %s', (code, fields) => {
    const d = fixture(); d.transactions.push(trade('2026-01-15', 'buy', 1, 10, fields));
    expect(calculate(d)).toMatchObject({ complete: false, gain: null, returnPct: null });
    expect(calculate(d).issues.some(i => i.code === code)).toBe(true);
    if (['missing_units', 'oversold_units'].includes(code)) expect(calculate(d).holdings[0].closing).toBeNull();
  });
  it('ignores name-only watchlist overrides but rejects undated opening positions', () => {
    const d = fixture(); d.meta.investments.holdingOverrides = { broker: { XYZ: { name: 'Watch' } } };
    expect(calculate(d).complete).toBe(true);
    d.transactions.push(trade('2026-01-31', 'dividend', undefined, 5, { symbol: 'XYZ' }));
    d.meta.investments.holdingOverrides.broker.XYZ.units = 5;
    expect(calculate(d).issues.some(i => i.code === 'undated_holding')).toBe(true);
  });
  it('uses dated manual trades, but refuses to invent cash for unit-only corrections', () => {
    const d = fixture(); d.meta.investments.manualRows = { broker: { ABC: [{ date: '2026-01-31', direction: 'buy', units: 1, amount: 12 }] } };
    expect(calculate(d)).toMatchObject({ contributions: 12, gain: 20, returnPct: 20 });
    d.meta.investments.manualRows.broker.ABC[0].direction = 'adjust';
    expect(calculate(d)).toMatchObject({ complete: false, returnPct: null });
  });
  it('does not require prices for a fully sold position at a boundary', () => {
    const d = fixture(); d.transactions.push(trade('2026-01-31', 'sell', 10, 120));
    d.meta.investments.priceHistory.ABC.pop();
    expect(calculate(d)).toMatchObject({ complete: true, closingValue: 0, gain: 20, returnPct: 20 });
  });
  it('does not divide by zero or negative weighted capital', () => {
    expect(modifiedDietz(0, 110, [{ date: '2026-01-31', amount: 100 }], input.from, input.to)).toMatchObject({ gain: 10, returnPct: null });
    expect(modifiedDietz(10, 0, [{ date: '2026-01-01', amount: -100 }], input.from, input.to).returnPct).toBeNull();
    expect(() => investmentPerformance(fixture(), { ...input, from: 'invalid' })).toThrow(RangeError);
  });
  it('uses calendar days across DST and leap days', () => {
    expect(modifiedDietz(100, 210, [{ date: '2024-02-29', amount: 100 }], '2024-02-28', '2024-03-01').weightedCapital).toBeCloseTo(133.3333333);
    expect(modifiedDietz(100, 210, [{ date: '2026-03-29', amount: 100 }], '2026-03-28', '2026-03-30').weightedCapital).toBeCloseTo(133.3333333);
  });
  it('query includes archived tracked accounts and validates dates/account selection', () => {
    const d = fixture();
    const query = overrides => runQuery(registry, d, 'investments.performance', { from: input.from, to: input.to, ...overrides }, ctx);
    expect(query({})).toMatchObject({ ok: true, value: { gain: 20, returnPct: 20, accountIds: ['broker'] } });
    expect(query({ account: 'bank' }).ok).toBe(false);
    expect(query({ to: '2026-02-03' }).ok).toBe(false);
    expect(query({ from: '2026-02-01' }).ok).toBe(false);
    expect(query({ maxPriceAgeDays: 32 }).ok).toBe(false);
    expect(query({ from: '2026-02-30' }).ok).toBe(false);
  });
  it('backfills historical prices without replacing a newer current quote', () => {
    const d = fixture(); d.meta.investments.prices = { ABC: { price: 15, asOf: '2026-02-01' } };
    const r = runCommand(registry, d, 'investment.setPrice', { symbol: 'ABC', price: 11, asOf: '2025-12-31', preserveNewer: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.changes.meta.investments.prices.ABC).toEqual(d.meta.investments.prices.ABC);
    expect(r.value.changes.meta.investments.priceHistory.ABC[0]).toEqual({ date: '2025-12-31', price: 11 });
    expect(d.meta.investments.priceHistory.ABC[0].price).toBe(10);
  });
});

it('retains exact transaction and manual-row provenance for repair links', () => {
  const d = fixture();
  d.transactions = [trade('2026-01-02', 'buy', null, 100, { id: 'a' }), trade('2026-01-02', 'buy', null, 200, { id: 'b' })];
  d.meta.investments.manualRows = { broker: { ABC: [{ id: 'manual', date: '2026-01-03', direction: 'adjust', units: 1, amount: 0 }] } };
  const issues = calculate(d).issues;
  expect(issues.filter(i => i.code === 'missing_units').map(i => i.transactionId)).toEqual(['a', 'b']);
  expect(issues.find(i => i.code === 'manual_adjustment')).toMatchObject({ manualRowId: 'manual' });
  expect(issues.find(i => i.code === 'manual_adjustment')).not.toHaveProperty('transactionId');
});
