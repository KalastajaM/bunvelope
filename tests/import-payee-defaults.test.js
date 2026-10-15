// An imported bank row defaults to its payee's envelope, from the same payee
// index Add transaction's autofill reads (UX 2026-10-05). The model's
// categorization, when there is one, still wins.
import { describe, it, expect } from 'vitest';
import { payeeHistoryDefault } from '../js/import/payee-defaults.js';
import { rowsNeedingCategorization, buildImportProposal } from '../js/import/build-proposal.js';

const tx = (over) => ({ id: over.id, type: 'expense', date: '2026-08-01', amount: 10, account: 'chk', status: 'posted', ...over });

function budget(transactions, extra = {}) {
  return {
    accounts: [{ id: 'chk', name: 'Checking' }],
    envelopes: [
      { id: 'subs', name: 'Online services' },
      { id: 'food', name: 'Food' },
      { id: 'pay', name: 'Salary' },
      { id: 'old', name: 'Old', archived: true },
    ],
    transactions,
    meta: {},
    ...extra,
  };
}

describe('payeeHistoryDefault', () => {
  it('gives the envelope of the payee\'s newest posted row, case-insensitively', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Spotify', envelope_id: 'food', date: '2026-01-01' }),
      tx({ id: 'b', payee: 'SPOTIFY', envelope_id: 'subs', date: '2026-08-01' }),
    ]);
    expect(payeeHistoryDefault(state, 'spotify', -9.99)).toEqual({ type: 'expense', envelope_id: 'subs' });
  });

  it('only when the bank sign gives the type the payee\'s row had', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Employer', type: 'income', envelope_id: 'pay' }),
      tx({ id: 'b', payee: 'Revolut', type: 'account_transfer', from_account: 'chk', to_account: 'rev' }),
    ]);
    expect(payeeHistoryDefault(state, 'Employer', 2000)).toEqual({ type: 'income', envelope_id: 'pay' });
    // Money out to a payee last seen as income: no guess.
    expect(payeeHistoryDefault(state, 'Employer', -20)).toBe(null);
    // A transfer says nothing about an expense.
    expect(payeeHistoryDefault(state, 'Revolut', -50)).toBe(null);
  });

  it('a split row falls back to the payee\'s last single envelope', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Prisma', envelope_id: 'food', date: '2026-07-01' }),
      tx({ id: 'b', payee: 'Prisma', envelope_id: null, date: '2026-08-01',
        envelope_splits: [{ envelope_id: 'food', amount: 5 }, { envelope_id: 'subs', amount: 5 }] }),
    ]);
    expect(payeeHistoryDefault(state, 'Prisma', -12)?.envelope_id).toBe('food');
  });

  it('nothing for an unknown payee, an archived or missing envelope, or a "no envelope" row', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Gone', envelope_id: 'old' }),
      tx({ id: 'b', payee: 'Ghost', envelope_id: 'deleted' }),
      tx({ id: 'c', payee: 'Fix', envelope_id: '__none__' }),
    ]);
    expect(payeeHistoryDefault(state, 'Nobody', -1)).toBe(null);
    expect(payeeHistoryDefault(state, 'Gone', -1)).toBe(null);
    expect(payeeHistoryDefault(state, 'Ghost', -1)).toBe(null);
    expect(payeeHistoryDefault(state, 'Fix', -1)).toBe(null);
    expect(payeeHistoryDefault(state, '', -1)).toBe(null);
  });

  it('matches the bank\'s spelling: without a company form, or by a known payee it starts with', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Spotify', envelope_id: 'subs' }),
      tx({ id: 'b', payee: 'K-Market', envelope_id: 'food' }),
      tx({ id: 'c', payee: 'K-Market Töölö', envelope_id: null, date: '2026-01-01' }),
      tx({ id: 'd', payee: 'Bar', envelope_id: 'food' }),
    ]);
    expect(payeeHistoryDefault(state, 'SPOTIFY AB', -9.99)?.envelope_id).toBe('subs');
    expect(payeeHistoryDefault(state, 'Spotify Oy', -9.99)?.envelope_id).toBe('subs');
    // The exact payee was imported unassigned before: the prefix still finds it.
    expect(payeeHistoryDefault(state, 'K-Market Töölö', -47.3)?.envelope_id).toBe('food');
    // Whole words only, and never a very short known payee.
    expect(payeeHistoryDefault(state, 'Spotifyx', -1)).toBe(null);
    expect(payeeHistoryDefault(state, 'Bar Centro', -1)).toBe(null);
  });

  it('a remembered spelling (payee alias) is looked up under its kept name', () => {
    const state = budget([tx({ id: 'a', payee: 'Spotify', envelope_id: 'subs' })],
      { meta: { payeeAliases: { 'spotify ab': 'Spotify' } } });
    expect(payeeHistoryDefault(state, 'SPOTIFY AB', -9.99)?.envelope_id).toBe('subs');
  });

  it('a posted row wins over a later scheduled one; a payee with only scheduled rows uses those, as the add form does', () => {
    const state = budget([
      tx({ id: 'a', payee: 'Rent', envelope_id: 'food', date: '2026-08-01' }),
      tx({ id: 'b', payee: 'Rent', envelope_id: 'subs', status: 'scheduled', date: '2026-12-01' }),
      tx({ id: 'c', payee: 'Gym', envelope_id: 'subs', status: 'scheduled', date: '2026-12-01' }),
    ]);
    expect(payeeHistoryDefault(state, 'Rent', -700)?.envelope_id).toBe('food');
    expect(payeeHistoryDefault(state, 'Gym', -30)?.envelope_id).toBe('subs');
  });
});

describe('buildImportProposal with payee history', () => {
  const state = budget([
    tx({ id: 'h1', payee: 'K-Market', envelope_id: 'food' }),
    tx({ id: 'h2', payee: 'Cafe', envelope_id: 'food' }),
  ]);
  const matched = [
    { csvRow: { date: '2026-08-05', payee: 'K-Market', amount: -20, note: 'Ostos' }, match: null, matchType: 'none' },
    { csvRow: { date: '2026-08-06', payee: 'Cafe', amount: -8 }, match: null, matchType: 'none' },
  ];

  it('defaults a row the model did not categorize from its payee', () => {
    const needing = rowsNeedingCategorization(matched);
    const p = buildImportProposal({ matched, needing, categorized: [], state, defaultAccountId: 'chk' });
    const byPayee = Object.fromEntries(p.rows.map((r) => [r.payee, r]));
    expect(byPayee['K-Market']).toMatchObject({ type: 'expense', envelope_id: 'food', note: 'Ostos' });
  });

  it('the model\'s categorization wins over the history', () => {
    const needing = rowsNeedingCategorization(matched);
    const categorized = [null, { index: 1, type: 'expense', envelope_id: 'subs', account_id: 'chk', confidence: 0.9 }];
    const p = buildImportProposal({ matched, needing, categorized, state, defaultAccountId: 'chk' });
    const byPayee = Object.fromEntries(p.rows.map((r) => [r.payee, r]));
    expect(byPayee.Cafe.envelope_id).toBe('subs');
    expect(byPayee['K-Market'].envelope_id).toBe('food');
  });
});
