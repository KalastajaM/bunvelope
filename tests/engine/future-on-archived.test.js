// Future transactions on archived accounts and envelopes: archiving hides
// them from the pickers but not from the ledger, so a row still ahead keeps
// posting against them. The status badge and the archive actions warn.
import { describe, it, expect } from 'vitest';
import { futureRowsTouching, findFutureRowsOnArchived } from '../../js/engine.js';

const TODAY = new Date(2026, 8, 29); // 2026-09-29

const accounts = [
  { id: 'chk', name: 'Checking' },
  { id: 'old', name: 'Closed bank', archived: true },
];
const envelopes = [
  { id: 'food', name: 'Food' },
  { id: 'gym', name: 'Gym', archived: true },
];

const tx = (over) => ({ id: 'x', type: 'expense', date: '2026-10-05', status: 'posted', amount: 10, account: 'chk', envelope_id: 'food', payee: 'P', ...over });

describe('findFutureRowsOnArchived', () => {
  it('finds future rows on an archived account or envelope, oldest first, naming which', () => {
    const rows = findFutureRowsOnArchived({
      accounts, envelopes, today: TODAY,
      transactions: [
        tx({ id: 'a', date: '2026-10-20', account: 'old' }),
        tx({ id: 'e', date: '2026-10-01', envelope_id: 'gym' }),
        tx({ id: 't', type: 'account_transfer', date: '2026-11-01', account: undefined, envelope_id: undefined, from_account: 'chk', to_account: 'old' }),
        tx({ id: 's', type: 'expense', date: '2026-10-02', envelope_id: null, envelope_splits: [{ envelope_id: 'food', amount: 5 }, { envelope_id: 'gym', amount: 5 }] }),
        tx({ id: 'ok', date: '2026-10-03' }),
      ],
    });
    expect(rows.map(r => [r.id, r.accountIds, r.envelopeIds])).toEqual([
      ['e', [], ['gym']],
      ['s', [], ['gym']],
      ['a', ['old'], []],
      ['t', ['old'], []],
    ]);
  });

  it('counts a scheduled-status row even when dated today or earlier, and ignores the past and forecasts', () => {
    const rows = findFutureRowsOnArchived({
      accounts, envelopes, today: TODAY,
      transactions: [
        tx({ id: 'sched', date: '2026-09-20', status: 'scheduled', account: 'old' }),
        tx({ id: 'past', date: '2026-09-20', account: 'old' }),
        tx({ id: 'today', date: '2026-09-29', account: 'old' }),
        tx({ id: 'fc', account: 'old', is_forecast: true }),
      ],
    });
    expect(rows.map(r => r.id)).toEqual(['sched']);
  });

  it('finds nothing when nothing is archived, and requires a clock', () => {
    expect(findFutureRowsOnArchived({
      accounts: [{ id: 'chk' }], envelopes: [{ id: 'food' }], today: TODAY, transactions: [tx({})],
    })).toEqual([]);
    expect(() => findFutureRowsOnArchived({ accounts, envelopes, transactions: [] })).toThrow(/valid Date/);
  });
});

describe('futureRowsTouching (the archive-time warning)', () => {
  it('counts the rows that would be left on an account or envelope about to be archived', () => {
    const transactions = [tx({ id: '1' }), tx({ id: '2', account: 'other' }), tx({ id: '3', date: '2026-09-01' })];
    expect(futureRowsTouching({ transactions, today: TODAY, accountIds: ['chk'] }).map(r => r.id)).toEqual(['1']);
    expect(futureRowsTouching({ transactions, today: TODAY, envelopeIds: ['food'] }).map(r => r.id)).toEqual(['1', '2']);
    expect(futureRowsTouching({ transactions, today: TODAY })).toEqual([]);
  });
});
