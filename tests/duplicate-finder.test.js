// The duplicate finder proposes rows recorded twice (what a cleanup writes is
// transaction.resolveDuplicates, tests/core-transaction-resolve-duplicates.test.js).
// Most of what is pinned here is what it must NOT pair: two real
// occurrences of a bill, two purchases in different envelopes, anything
// across accounts or amounts.
import { describe, it, expect } from 'vitest';
import {
  findDuplicateGroups, pairKey, getDismissedPairs, dismissGroup,
  PLAIN_DAY_WINDOW, POSTED_DAY_WINDOW,
} from '../js/state/duplicate-finder.js';

const tx = (id, over = {}) => ({
  id, type: 'expense', date: '2026-09-10', status: 'posted', amount: 42.5,
  account: 'chk', envelope_id: 'food', payee: 'K-Market', ...over,
});
const find = (transactions, dismissed) => findDuplicateGroups({ transactions, dismissed });
const shape = (groups) => groups.map(g => [g.kind, g.rows.map(r => r.id), g.keepId, g.key, g.recommended]);

describe('findDuplicateGroups: what pairs', () => {
  it('an automatic post over a hand entry for the same bill, keeping the hand entry and its key', () => {
    const groups = find([
      tx('hand', { date: '2026-09-03', payee: 'Gym' }),
      tx('auto', { date: '2026-09-06', payee: 'Gym membership', from_budget: 'bi-gym:2026-09' }),
    ]);
    expect(shape(groups)).toEqual([['postedOverHand', ['hand', 'auto'], 'hand', 'bi-gym:2026-09', true]]);
  });

  it('one scheduled occurrence posted twice, at any distance', () => {
    const groups = find([
      tx('a', { date: '2026-09-06', from_budget: 'bi-x:2026-09' }),
      tx('b', { date: '2026-09-28', from_budget: 'bi-x:2026-09' }),
    ]);
    expect(shape(groups)).toEqual([['sameKey', ['a', 'b'], 'a', 'bi-x:2026-09', true]]);
  });

  it('the same payee typed twice within a few days, never pre-ticked', () => {
    const groups = find([tx('a', { payee: 'LIDL 1234' }), tx('b', { date: '2026-09-12', payee: 'Lidl' })]);
    expect(shape(groups)).toEqual([['plain', ['a', 'b'], 'a', null, false]]);
  });

  it('a transfer on the same route, and income on the same account', () => {
    const tr = (id, date) => ({ id, type: 'account_transfer', date, amount: 500, from_account: 'chk', to_account: 'sav', payee: 'Savings' });
    expect(find([tr('t1', '2026-09-01'), tr('t2', '2026-09-02')]).map(g => g.kind)).toEqual(['plain']);
    const inc = (id) => tx(id, { type: 'income', envelope_id: null, payee: 'Salary' });
    expect(find([inc('i1'), inc('i2')]).map(g => g.kind)).toEqual(['plain']);
  });

  it('keeps the reconciled row by default', () => {
    const one = find([
      tx('hand'),
      tx('auto', { from_budget: 'bi-x:2026-09', cleared: true }),
    ]);
    expect(one[0].keepId).toBe('auto');
  });
});

describe('findDuplicateGroups: what does not pair', () => {
  it('two rows that were both reconciled: a statement showed both', () => {
    expect(find([tx('a', { cleared: true }), tx('b', { cleared: true })])).toEqual([]);
    expect(find([
      tx('hand', { cleared: true }),
      tx('auto', { from_budget: 'bi-x:2026-09', cleared: true }),
    ])).toEqual([]);
  });

  it('an automatic post and a hand entry with unrelated payees (two subscriptions at one price)', () => {
    expect(find([
      tx('hand', { payee: 'Amazon Prime', amount: 8.99 }),
      tx('auto', { payee: 'Viaplay', amount: 8.99, from_budget: 'bi-v:2026-09' }),
    ])).toEqual([]);
  });

  it('two different occurrences of a bill, even on the same day', () => {
    expect(find([
      tx('a', { from_budget: 'bi-x:2026-08' }),
      tx('b', { from_budget: 'bi-x:2026-09' }),
    ])).toEqual([]);
  });

  it('different account, amount, type, route or envelope', () => {
    expect(find([tx('a'), tx('b', { account: 'card' })])).toEqual([]);
    expect(find([tx('a'), tx('b', { amount: 42.51 })])).toEqual([]);
    expect(find([tx('a'), tx('b', { type: 'income', envelope_id: null })])).toEqual([]);
    expect(find([tx('a'), tx('b', { envelope_id: 'fun' })])).toEqual([]);
    const tr = (id, to) => ({ id, type: 'account_transfer', date: '2026-09-01', amount: 5, from_account: 'chk', to_account: to, payee: 'x' });
    expect(find([tr('a', 'sav'), tr('b', 'card')])).toEqual([]);
  });

  it('untagged rows too far apart or with different payees', () => {
    expect(find([tx('a'), tx('b', { date: `2026-09-${10 + PLAIN_DAY_WINDOW + 1}` })])).toEqual([]);
    expect(find([tx('a'), tx('b', { payee: 'Prisma' })])).toEqual([]);
  });

  it('a hand entry more than the posting window from the automatic post', () => {
    expect(find([
      tx('hand', { date: '2026-09-01' }),
      tx('auto', { date: `2026-09-${String(1 + POSTED_DAY_WINDOW + 1).padStart(2, '0')}`, from_budget: 'bi-x:2026-09' }),
    ])).toEqual([]);
  });

  it('forecast rows, fills and rows sharing an id', () => {
    expect(find([tx('a'), tx('b', { is_forecast: true })])).toEqual([]);
    expect(find([
      { id: 'f1', type: 'fill', date: '2026-09-01', lines: [] },
      { id: 'f2', type: 'fill', date: '2026-09-01', lines: [] },
    ])).toEqual([]);
    expect(find([tx('same'), tx('same', { date: '2026-09-11' })])).toEqual([]);
  });
});

describe('findDuplicateGroups: groups and dismissals', () => {
  it('never joins two different keys through a hand entry between them', () => {
    const groups = find([
      tx('aug', { date: '2026-09-01', from_budget: 'bi-x:2026-08' }),
      tx('hand', { date: '2026-09-05' }),
      tx('sep', { date: '2026-09-08', from_budget: 'bi-x:2026-09' }),
    ]);
    expect(groups).toHaveLength(1);
    // The nearer post wins the hand entry; the other stays on its own.
    expect(groups[0].rows.map(r => r.id)).toEqual(['hand', 'sep']);
    expect(groups[0].key).toBe('bi-x:2026-09');
  });

  it('lists the surest kind first, then the oldest', () => {
    const groups = find([
      tx('p1', { date: '2026-09-01', payee: 'Cafe', amount: 3 }),
      tx('p2', { date: '2026-09-02', payee: 'Cafe', amount: 3 }),
      tx('h', { date: '2026-09-20' }),
      tx('a', { date: '2026-09-21', from_budget: 'bi-x:2026-09' }),
    ]);
    expect(groups.map(g => g.kind)).toEqual(['postedOverHand', 'plain']);
  });

  it('three copies are one group', () => {
    const groups = find([tx('a'), tx('b', { date: '2026-09-11' }), tx('c', { date: '2026-09-12' })]);
    expect(groups.map(g => g.rows.map(r => r.id))).toEqual([['a', 'b', 'c']]);
  });

  it('a dismissed group stays hidden until a new copy joins it', () => {
    const rows = [tx('a'), tx('b', { date: '2026-09-11' })];
    const [group] = find(rows);
    const meta = dismissGroup({ other: 1 }, group);
    expect(meta.other).toBe(1);
    expect(meta.duplicateDismissed).toEqual([pairKey('a', 'b')]);
    const dismissed = getDismissedPairs(meta);
    expect(find(rows, dismissed)).toEqual([]);
    expect(find([...rows, tx('c', { date: '2026-09-12' })], dismissed)).toHaveLength(1);
  });

  it('reads a malformed dismissal list as empty', () => {
    expect(getDismissedPairs({ duplicateDismissed: 'x' }).size).toBe(0);
    expect([...getDismissedPairs({ duplicateDismissed: ['a|b', 3] })]).toEqual(['a|b']);
  });
});
