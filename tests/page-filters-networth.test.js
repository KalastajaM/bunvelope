// Net worth page filter: which part an account counts under, and net worth
// over a subset of accounts from one balance map.
import { describe, it, expect } from 'vitest';
import { netWorthFromBalances, netWorthPartOf } from '../js/engine.js';

const accts = [
  { id: 'b', type: 'bank' },
  { id: 's', type: 'savings' },
  { id: 'i', type: 'investment' },
  { id: 'p', type: 'investment', pensionInsurance: true },
  { id: 'h', type: 'asset', group: 'Properties' },
  { id: 'm', type: 'asset', group: 'Properties' },
];

describe('netWorthPartOf', () => {
  it('names the part netWorthFromBalances counts each account under', () => {
    for (const a of accts) {
      const split = netWorthFromBalances([a], new Map([[a.id, 10]]));
      expect(split[netWorthPartOf(a)]).toBe(10);
    }
    expect(netWorthPartOf({ id: 'p', type: 'investment', pensionInsurance: true })).toBe('pension');
    expect(netWorthPartOf({ id: 'h', type: 'asset' })).toBe('assets');
  });

  it('agrees with netWorthFromBalances on the spending override and the fallback', () => {
    const cases = [
      // An unknown type (not one the app offers) is not spending by default.
      [{ id: 'x', type: 'mystery' }, 'other'],
      // Loans owed and given each get a line of their own.
      [{ id: 'l', type: 'loan' }, 'debts'],
      [{ id: 'g', type: 'loan_given' }, 'loansGiven'],
      // An explicit spending: false takes a bank account out of spending, and
      // it is none of savings / investment either.
      [{ id: 'bn', type: 'bank', spending: false }, 'other'],
      // An explicit spending: true wins over the savings type.
      [{ id: 'sy', type: 'savings', spending: true }, 'spending'],
    ];
    for (const [a, part] of cases) {
      expect(netWorthPartOf(a)).toBe(part);
      const split = netWorthFromBalances([a], new Map([[a.id, 10]]));
      expect(split[netWorthPartOf(a)]).toBe(10);
    }
  });

  it('puts a missing account under other', () => {
    expect(netWorthPartOf(null)).toBe('other');
    expect(netWorthPartOf(undefined)).toBe('other');
  });
});

describe('netWorthFromBalances over a subset', () => {
  it('totals only the accounts passed in', () => {
    const bal = new Map([['b', 100], ['s', 200], ['h', 300000], ['m', -250000]]);
    const all = netWorthFromBalances(accts, bal);
    const withoutHouse = netWorthFromBalances(accts.filter(a => a.group !== 'Properties'), bal);
    expect(all.total - withoutHouse.total).toBe(50000);
    expect(withoutHouse.assets).toBe(0);
  });
});
