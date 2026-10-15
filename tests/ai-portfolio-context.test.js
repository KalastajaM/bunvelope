// tests/ai-portfolio-context.test.js — buildPortfolioInsightCtx checks.
// No network, no mocks. The builder is pure.

import { describe, it, expect } from 'vitest';
import { buildPortfolioInsightCtx } from '../js/ai/context-builder.js';

// The fixture's rows are dated from the wall clock, so the builder is given it.
const WALL = () => new Date();

function iso(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { return iso(new Date(Date.now() - n * 86_400_000)); }

function makeFixtureState() {
  const accounts = [
    { id: 'broker-1', name: 'Broker', type: 'investment' },
    { id: 'broker-2', name: 'IRA',    type: 'investment' },
    { id: 'cash-1',   name: 'Cash',   type: 'checking'   },
  ];
  const transactions = [
    // Buy AAPL on broker-1 (recent so it falls in the 12mo window).
    {
      id: 'tx-buy-aapl', type: 'investment_transfer', status: 'posted',
      date: daysAgo(60), direction: 'buy', symbol: 'AAPL', units: 10,
      amount: 1500, from_account: 'cash-1', to_account: 'broker-1',
      notes: 'private brokerage memo',
    },
    // Buy MSFT on broker-1.
    {
      id: 'tx-buy-msft', type: 'investment_transfer', status: 'posted',
      date: daysAgo(45), direction: 'buy', symbol: 'MSFT', units: 5,
      amount: 1800, from_account: 'cash-1', to_account: 'broker-1',
    },
    // Dividend from AAPL.
    {
      id: 'tx-div-aapl', type: 'investment_transfer', status: 'posted',
      date: daysAgo(20), direction: 'dividend', symbol: 'AAPL',
      amount: 24, from_account: 'broker-1', to_account: 'cash-1',
    },
    // Cash transfer parking €500 in broker-2 (no holdings → idle cash).
    {
      id: 'tx-cash-park', type: 'account_transfer', status: 'posted',
      date: daysAgo(10), amount: 500,
      from_account: 'cash-1', to_account: 'broker-2',
    },
  ];
  return {
    envelopes: [],
    accounts,
    transactions,
    budgetItems: [],
    envelopeTemplates: [],
    meta: { currency: 'EUR' },
  };
}

describe('buildPortfolioInsightCtx', () => {
  it('emits cost-basis-only fields and never live prices', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/"price"/);
    expect(json).not.toMatch(/"market_value"/);
    expect(json).not.toMatch(/"unrealized"/);
    expect(json).not.toMatch(/"current_value"/);
    // Holdings rows should report cost_basis but not any price field.
    for (const h of ctx.holdings) {
      expect(typeof h.cost_basis).toBe('number');
      expect(h.price).toBeUndefined();
    }
  });

  it('strips free-text notes', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    expect(JSON.stringify(ctx)).not.toMatch(/private brokerage memo/);
  });

  it('aggregates holdings only for investment accounts', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    const symbols = ctx.holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(['AAPL', 'MSFT']);
    for (const h of ctx.holdings) {
      expect(['broker-1', 'broker-2']).toContain(h.account_id);
    }
  });

  it('symbol_mix percentages sum to ~100 when there are holdings', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    expect(ctx.symbol_mix.length).toBeGreaterThan(0);
    const sum = ctx.symbol_mix.reduce((s, r) => s + r.pct, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });

  it('contribution series has 12 buckets with month strings', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    expect(ctx.contributions.monthly.length).toBe(12);
    for (const b of ctx.contributions.monthly) {
      expect(b.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof b.net).toBe('number');
      expect(typeof b.buys).toBe('number');
      expect(typeof b.sells).toBe('number');
      expect(typeof b.dividends).toBe('number');
    }
    // Two buys in the window → last12m_net_contrib > 0.
    expect(ctx.contributions.last12m_net_contrib).toBeGreaterThan(0);
    expect(ctx.contributions.last12m_dividend_total).toBeGreaterThan(0);
  });

  it('detects idle cash on investment accounts with no units', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    const idle = ctx.idle_cash.find((i) => i.account_id === 'broker-2');
    expect(idle).toBeTruthy();
    expect(idle.balance).toBeCloseTo(500, 2);
    // broker-1 holds units, so it should not appear as idle cash.
    expect(ctx.idle_cash.find((i) => i.account_id === 'broker-1')).toBeUndefined();
  });

  it('totals.symbols counts distinct symbols in scope', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    expect(ctx.totals.symbols).toBe(2);
    expect(ctx.totals.cost_basis).toBeCloseTo(3300, 2);
  });

  it('returns an empty-ish payload when there are no investment accounts', () => {
    const state = {
      envelopes: [], accounts: [{ id: 'a', name: 'a', type: 'checking' }],
      transactions: [], budgetItems: [], meta: {},
    };
    const ctx = buildPortfolioInsightCtx(state, WALL);
    expect(ctx.holdings).toEqual([]);
    expect(ctx.symbol_mix).toEqual([]);
    expect(ctx.idle_cash).toEqual([]);
    expect(ctx.totals.symbols).toBe(0);
  });

  it('rounds money fields to 2 decimals', () => {
    const ctx = buildPortfolioInsightCtx(makeFixtureState(), WALL);
    function check(v) {
      if (typeof v === 'number' && Number.isFinite(v) && v !== Math.trunc(v)) {
        const rounded = Math.round(v * 100) / 100;
        expect(v).toBeCloseTo(rounded, 6);
      }
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (const [k, v] of Object.entries(node)) {
        // `units` keeps 6dp precision for crypto holdings — exempt.
        if (k === 'units') continue;
        if (typeof v === 'number') check(v);
        else walk(v);
      }
    }
    walk(ctx);
  });
});


it('keeps value-only holdings out of cost concentration and realized-gain context', () => {
  const state = makeFixtureState();
  state.meta.investments = { holdingOverrides: { 'broker-1': { NECKLACE: { units: 1, costBasis: 900, valuationOnly: true } } } };
  const ctx = buildPortfolioInsightCtx(state, WALL);
  expect(ctx.holdings.find(h => h.symbol === 'NECKLACE')).toMatchObject({ cost_basis: null, realized: null, valuation_only: true });
  expect(ctx.totals.cost_basis).toBe(3300);
  expect(ctx.symbol_mix.some(s => s.symbol === 'NECKLACE')).toBe(false);
});
