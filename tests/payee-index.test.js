import { describe, it, expect } from 'vitest';
import { rebuildPayeeIndex, topPayees, allPayees, findPayeeEntry, markPayeeIndexStale } from '../js/state/payee-index.js';

describe('rebuildPayeeIndex', () => {
  // ux-review U16: rank by use, count only posted rows, remember the envelope.
  it('ranks payees used more often in the last year first', () => {
    const state = {
      transactions: [
        { payee: 'Rare', date: '2026-09-20' },
        { payee: 'Weekly', date: '2026-09-01' },
        { payee: 'Weekly', date: '2026-09-08' },
        { payee: 'Weekly', date: '2026-09-15' },
        { payee: 'Old habit', date: '2024-01-01' },
        { payee: 'Old habit', date: '2024-01-08' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex.map(e => e.payee)).toEqual(['Weekly', 'Rare', 'Old habit']);
  });

  it('does not let a far-future scheduled row top the list', () => {
    const state = {
      transactions: [
        { payee: 'Instalment', date: '2031-08-17', status: 'scheduled' },
        { payee: 'Grocer', date: '2026-09-20' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex.map(e => e.payee)).toEqual(['Grocer', 'Instalment']);
    // A scheduled-only payee still autocompletes, from its scheduled row.
    expect(findPayeeEntry(state, 'instalment').lastTx.date).toBe('2031-08-17');
  });

  it('leaves out the labels of rows that only move money between envelopes', () => {
    const state = {
      transactions: [
        { payee: 'Fill envelopes', type: 'fill', date: '2026-09-01' },
        { payee: 'Rollover: sweep to unallocated', type: 'adjustment', target: 'envelope', date: '2026-08-31' },
        { payee: 'Move', type: 'envelope_transfer', date: '2026-09-02' },
        { payee: 'Bank fix', type: 'adjustment', target: 'account', date: '2026-09-03' },
        { payee: 'Grocer', type: 'expense', date: '2026-09-04' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex.map(e => e.payee).sort()).toEqual(['Bank fix', 'Grocer']);
  });

  it('remembers the last single envelope when the newest row is a split', () => {
    const state = {
      transactions: [
        { id: 'a', type: 'expense', payee: 'Shop', date: '2026-09-01', envelope_id: 'groceries' },
        { id: 'b', type: 'expense', payee: 'Shop', date: '2026-09-10',
          envelope_splits: [{ envelope_id: 'groceries', amount: 5 }, { envelope_id: 'home', amount: 5 }] },
      ],
    };
    rebuildPayeeIndex(state);
    const e = findPayeeEntry(state, 'shop');
    expect(e.lastTx.id).toBe('b');
    expect(e.lastEnvelopeId).toBe('groceries');
  });

  it('dedupes by lowercase trimmed payee', () => {
    const state = {
      transactions: [
        { payee: 'Aldi', date: '2026-01-01' },
        { payee: ' aldi ', date: '2026-02-01' },
        { payee: 'ALDI',  date: '2025-12-01' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex).toHaveLength(1);
    expect(state.payeeIndex[0].payee).toBe('aldi'); // most recent raw (trimmed)
    expect(state.payeeIndex[0].lastDate).toBe('2026-02-01');
  });

  it('orders entries by most recent date desc, alpha tiebreak', () => {
    const state = {
      transactions: [
        { payee: 'Zoo', date: '2026-01-01' },
        { payee: 'Aldi', date: '2026-01-01' },
        { payee: 'Lidl', date: '2026-03-01' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex.map(e => e.payee)).toEqual(['Lidl', 'Aldi', 'Zoo']);
  });

  it('skips transactions with empty or whitespace payees', () => {
    const state = {
      transactions: [
        { payee: '', date: '2026-01-01' },
        { payee: '   ', date: '2026-01-01' },
        { payee: null, date: '2026-01-01' },
        { payee: undefined, date: '2026-01-01' },
        { payee: 'Real Payee', date: '2026-01-01' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex).toHaveLength(1);
    expect(state.payeeIndex[0].payee).toBe('Real Payee');
  });

  it('stores the most recent full tx per payee', () => {
    const state = {
      transactions: [
        { id: 'a', payee: 'Shop', date: '2025-01-01', envelope_id: 'old' },
        { id: 'b', payee: 'Shop', date: '2026-01-01', envelope_id: 'new' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex[0].lastTx.id).toBe('b');
    expect(state.payeeIndex[0].lastTx.envelope_id).toBe('new');
  });

  it('handles empty transactions array', () => {
    const state = { transactions: [] };
    rebuildPayeeIndex(state);
    expect(state.payeeIndex).toEqual([]);
  });
});

describe('topPayees', () => {
  it('returns up to n payee strings in index order', () => {
    const state = {
      payeeIndex: [
        { payee: 'A', lastDate: '2026-03-01', lastTx: {} },
        { payee: 'B', lastDate: '2026-02-01', lastTx: {} },
        { payee: 'C', lastDate: '2026-01-01', lastTx: {} },
      ],
    };
    expect(topPayees(state, 2)).toEqual(['A', 'B']);
  });

  it('tolerates missing index (returns empty)', () => {
    expect(topPayees({}, 10)).toEqual([]);
  });
});

describe('allPayees', () => {
  it('returns every payee in index order', () => {
    const state = {
      payeeIndex: [
        { payee: 'A', lastDate: '2026-03-01', lastTx: {} },
        { payee: 'B', lastDate: '2026-02-01', lastTx: {} },
        { payee: 'C', lastDate: '2026-01-01', lastTx: {} },
      ],
    };
    expect(allPayees(state)).toEqual(['A', 'B', 'C']);
  });

  it('tolerates missing index (returns empty)', () => {
    expect(allPayees({})).toEqual([]);
  });
});

describe('findPayeeEntry', () => {
  it('matches case-insensitively and trims', () => {
    const state = {
      payeeIndex: [
        { payee: 'Aldi', lastDate: '2026-01-01', lastTx: { id: 'x' } },
      ],
      payeeIndexMap: new Map([
        ['aldi', { payee: 'Aldi', lastDate: '2026-01-01', lastTx: { id: 'x' } }],
      ]),
    };
    expect(findPayeeEntry(state, ' ALDI ').lastTx.id).toBe('x');
  });

  it('returns null on no match', () => {
    expect(findPayeeEntry({ payeeIndex: [], payeeIndexMap: new Map() }, 'nope')).toBe(null);
  });

  it('tolerates missing index', () => {
    expect(findPayeeEntry({}, 'anything')).toBe(null);
  });

  it('returns null for whitespace-only input', () => {
    const state = {
      payeeIndex: [
        { payee: 'Aldi', lastDate: '2026-01-01', lastTx: { id: 'x' } },
      ],
      payeeIndexMap: new Map([
        ['aldi', { payee: 'Aldi', lastDate: '2026-01-01', lastTx: { id: 'x' } }],
      ]),
    };
    expect(findPayeeEntry(state, '   ')).toBe(null);
  });
});

describe('rebuildPayeeIndex — payeeIndexMap', () => {
  it('builds a lowercase-keyed Map whose values are the same refs as payeeIndex entries', () => {
    const state = {
      transactions: [
        { payee: 'Aldi', date: '2026-01-01' },
        { payee: 'Lidl', date: '2026-02-01' },
        { payee: 'ZOO',  date: '2026-03-01' },
      ],
    };
    rebuildPayeeIndex(state);
    expect(state.payeeIndexMap).toBeInstanceOf(Map);
    expect([...state.payeeIndexMap.keys()].sort()).toEqual(['aldi', 'lidl', 'zoo']);
    for (const entry of state.payeeIndex) {
      const key = entry.payee.trim().toLowerCase();
      expect(state.payeeIndexMap.get(key)).toBe(entry); // same object reference
    }
  });
});

describe('lazy rebuild', () => {
  it('readers rebuild once after state.transactions is replaced, and not again until it changes', () => {
    const state = { transactions: [{ id: 'a', payee: 'Aldi', date: '2026-01-01' }] };
    expect(allPayees(state)).toEqual(['Aldi']);
    const built = state.payeeIndex;
    expect(allPayees(state)).toEqual(['Aldi']);
    expect(state.payeeIndex).toBe(built); // no rescan for an unchanged ledger

    // A write path that assigns a new array without touching the index.
    state.transactions = [...state.transactions, { id: 'b', payee: 'Lidl', date: '2026-02-01' }];
    expect(topPayees(state, 1)).toEqual(['Lidl']);
    expect(findPayeeEntry(state, 'lidl').lastTx.id).toBe('b');
  });

  it('markPayeeIndexStale forces a rebuild after an in-place mutation', () => {
    const state = { transactions: [{ id: 'a', payee: 'Aldi', date: '2026-01-01' }] };
    expect(allPayees(state)).toEqual(['Aldi']);
    state.transactions.push({ id: 'b', payee: 'Zoo', date: '2026-03-01' });
    markPayeeIndexStale(state);
    expect(allPayees(state)).toEqual(['Zoo', 'Aldi']);
  });
});

describe('hidden payees', () => {
  it('leaves hidden payees out of allPayees and topPayees but still finds them', () => {
    const state = {
      meta: { payeeHidden: ['prisma'] },
      transactions: [
        { id: 'a', payee: 'Prisma', date: '2026-09-01' },
        { id: 'b', payee: 'Prisma', date: '2026-09-02' },
        { id: 'c', payee: 'Lidl', date: '2026-09-03' },
        { id: 'd', payee: 'Aldi', date: '2026-08-01' },
      ],
    };
    expect(allPayees(state)).toEqual(['Lidl', 'Aldi']);
    expect(topPayees(state, 2)).toEqual(['Lidl', 'Aldi']); // filtered before slicing
    expect(findPayeeEntry(state, 'Prisma').lastTx.id).toBe('b');
  });

  it('picks up a change to the hidden set without a transactions change', () => {
    const state = {
      meta: {},
      transactions: [
        { id: 'a', payee: 'Prisma', date: '2026-09-01' },
        { id: 'c', payee: 'Lidl', date: '2026-09-03' },
      ],
    };
    expect(allPayees(state)).toEqual(['Lidl', 'Prisma']);
    state.meta = { payeeHidden: ['prisma'] };
    expect(allPayees(state)).toEqual(['Lidl']);
    expect(topPayees(state, 5)).toEqual(['Lidl']);
    state.meta = { payeeHidden: [] };
    expect(allPayees(state)).toEqual(['Lidl', 'Prisma']);
  });
});
