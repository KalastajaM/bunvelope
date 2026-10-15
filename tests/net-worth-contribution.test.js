// The Net worth projection's monthly amount per account after 24 months
// (core's rule), and the page's saved source.
import { describe, it, expect } from 'vitest';
import { contributionFor } from '../js/core/projection.js';
import { readContributionSource } from '../js/pages/net-worth-contribution.js';

describe('contributionFor', () => {
  const amounts = { plan: -250, history: 400 };

  it('uses the plan by default and the last 12 months when asked', () => {
    expect(contributionFor({ type: 'bank' }, amounts, 'plan')).toEqual({ amount: -250, source: 'plan' });
    expect(contributionFor({ type: 'bank' }, amounts, 'history')).toEqual({ amount: 400, source: 'history' });
  });

  it('an amount typed on the account wins over either source', () => {
    expect(contributionFor({ type: 'bank', plannedMonthly: 100 }, amounts, 'history')).toEqual({ amount: 100, source: 'set' });
    expect(contributionFor({ type: 'bank', plannedMonthly: 0 }, amounts, 'plan')).toEqual({ amount: 0, source: 'set' });
  });

  it('an asset account gets nothing from either source', () => {
    expect(contributionFor({ type: 'asset' }, amounts, 'history')).toEqual({ amount: 0, source: 'none' });
  });
});

describe('readContributionSource', () => {
  it('reads the saved choice, plan unless it is valid', () => {
    expect(readContributionSource({ contributionSource: 'history' })).toBe('history');
    expect(readContributionSource({ contributionSource: 'plan' })).toBe('plan');
    expect(readContributionSource({ contributionSource: 'evil' })).toBe('plan');
    expect(readContributionSource({})).toBe('plan');
    expect(readContributionSource(null)).toBe('plan');
  });
});
