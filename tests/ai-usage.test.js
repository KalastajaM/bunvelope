// tests/ai-usage.test.js — session token accounting and pricing.
//
// The figure is shown to a user spending their own key, so the arithmetic
// should be right and the cached-input discount should actually apply — a
// multi-turn conversation re-sends its whole prefix every turn, and pricing
// that at full rate would overstate the cost several-fold.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage, getUsage, resetUsage, costOf, onUsageChange, formatCost, formatTokens,
} from '../js/ai/usage.js';

const msg = (usage, model = 'claude-opus-5') => ({ model, usage, content: [] });

beforeEach(() => resetUsage());

describe('costOf', () => {
  it('prices input and output at the model rate', () => {
    // Opus 5: $5/MTok in, $25/MTok out.
    const cost = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-5');
    expect(cost).toBeCloseTo(30, 6);
  });

  it('prices Haiku far below Opus for identical usage', () => {
    const usage = { input_tokens: 100_000, output_tokens: 10_000 };
    const haiku = costOf(usage, 'claude-haiku-4-5-20251001');
    const opus = costOf(usage, 'claude-opus-5');
    expect(haiku).toBeLessThan(opus);
    expect(haiku).toBeCloseTo(0.15, 6);   // 100k×$1 + 10k×$5 per MTok
  });

  it('discounts cached reads and surcharges cache writes', () => {
    const read = costOf({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5');
    const write = costOf({ cache_creation_input_tokens: 1_000_000 }, 'claude-opus-5');
    expect(read).toBeCloseTo(0.5, 6);     // 0.1 × $5
    expect(write).toBeCloseTo(6.25, 6);   // 1.25 × $5
  });

  it('prices the current Sonnet and Opus at their own rates', () => {
    const m = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(costOf(m, 'claude-sonnet-5-5')).toBeCloseTo(12, 6);
    expect(costOf(m, 'claude-opus-5-5')).toBeCloseTo(24, 6);
    // Opus 5.5 reads its cache at $0.20, not a tenth of its $4 input.
    expect(costOf({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5-5')).toBeCloseTo(0.2, 6);
  });

  it('falls back to the dearest tier for an unknown model, never the cheapest', () => {
    const unknown = costOf({ input_tokens: 1_000_000 }, 'claude-something-new');
    const haiku = costOf({ input_tokens: 1_000_000 }, 'claude-haiku-4-5');
    expect(unknown).toBeGreaterThan(haiku);
  });

  it('is zero for a response with no usage block', () => {
    expect(costOf(null, 'claude-opus-5')).toBe(0);
  });
});

describe('recordUsage', () => {
  it('returns the message so it can wrap a transport call', () => {
    const m = msg({ input_tokens: 10, output_tokens: 5 });
    expect(recordUsage(m)).toBe(m);
  });

  it('accumulates across calls', () => {
    recordUsage(msg({ input_tokens: 1000, output_tokens: 100 }));
    recordUsage(msg({ input_tokens: 2000, output_tokens: 200 }));
    const u = getUsage();
    expect(u.calls).toBe(2);
    expect(u.inputTokens).toBe(3000);
    expect(u.outputTokens).toBe(300);
    expect(u.costUsd).toBeGreaterThan(0);
  });

  it('counts cache tokens separately from fresh input', () => {
    recordUsage(msg({
      input_tokens: 100, output_tokens: 50,
      cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000,
    }));
    const u = getUsage();
    expect(u.inputTokens).toBe(100);
    expect(u.cacheWriteTokens).toBe(2000);
    expect(u.cacheReadTokens).toBe(8000);
  });

  it('ignores a response with no usage rather than counting a call', () => {
    recordUsage({ model: 'claude-opus-5', content: [] });
    expect(getUsage().calls).toBe(0);
  });

  it('survives being handed nothing', () => {
    expect(() => recordUsage(null)).not.toThrow();
    expect(getUsage().calls).toBe(0);
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    const seen = [];
    const off = onUsageChange((u) => seen.push(u.calls));
    recordUsage(msg({ input_tokens: 1, output_tokens: 1 }));
    off();
    recordUsage(msg({ input_tokens: 1, output_tokens: 1 }));
    expect(seen).toEqual([1]);
  });

  it('resets to zero', () => {
    recordUsage(msg({ input_tokens: 5000, output_tokens: 500 }));
    resetUsage();
    expect(getUsage()).toMatchObject({ calls: 0, inputTokens: 0, costUsd: 0 });
  });
});

describe('formatting', () => {
  it('does not print a sub-cent cost as free', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(12.5)).toBe('$12.50');
  });

  it('abbreviates token counts', () => {
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });
});
