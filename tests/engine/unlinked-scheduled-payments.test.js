// `findUnlinkedScheduledPayments` proposes restoring the `from_budget` key on a
// scheduled bill that was plainly paid by a transaction carrying no such key.
//
// It is a data edit: writing the key changes what the forecast believes AND
// stops `materializeDueBudgetItems` posting that occurrence. So the matcher has
// to be timid, and most of what is pinned here is what it REFUSES to propose.

import { describe, it, expect } from 'vitest';
import {
  findUnlinkedScheduledPayments, projectEnvelopeBalance, materializeDueBudgetItems,
} from '../../js/engine.js';

const ENVELOPES = [
  { id: 'metsa', name: 'Metsareuna' },
  { id: 'other', name: 'Other' },
  { id: 'gone', name: 'Archived', archived: true },
];

const NO_MONTHS = {
  Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
  Jul: false, Aug: false, Sep: false, Oct: false, Nov: false, Dec: false,
};

const TAX_ITEM = {
  id: 'bi-tax', envelope_id: 'metsa', description: 'Property tax',
  default_amount: 183.6, include: true, payment_day: 6, as_schedule: true,
  account_id: 'a1',
  monthly_schedule: { ...NO_MONTHS, Aug: 183.6, Oct: 183.6 },
};

const TODAY = new Date(2026, 7, 24); // 2026-08-24

const payment = (over = {}) => ({
  id: 'x-aug', type: 'expense', date: '2026-08-06', status: 'posted',
  amount: 183.6, envelope_id: 'metsa', account: 'a1', payee: 'Property tax',
  ...over,
});

const find = (transactions, over = {}) => findUnlinkedScheduledPayments({
  budgetItems: [TAX_ITEM],
  envelopes: ENVELOPES,
  transactions,
  today: TODAY,
  tombstones: [],
  ...over,
});

describe('findUnlinkedScheduledPayments', () => {
  it('proposes the occurrence an untagged payment settles', () => {
    const out = find([payment()]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: 'bi-tax:2026-08',
      itemId: 'bi-tax',
      itemDescription: 'Property tax',
      envelopeId: 'metsa',
      envelopeName: 'Metsareuna',
      monthKey: '2026-08',
      dueDate: '2026-08-06',
      dueAmount: 183.6,
      txId: 'x-aug',
      txDate: '2026-08-06',
      txAmount: 183.6,
    });
  });

  it('proposes nothing when the payment already carries its key', () => {
    expect(find([payment({ from_budget: 'bi-tax:2026-08' })])).toEqual([]);
  });

  it('proposes nothing when the occurrence was tombstoned', () => {
    expect(find([payment()], { tombstones: ['bi-tax:2026-08'] })).toEqual([]);
  });

  it('proposes nothing when no payment was made', () => {
    expect(find([])).toEqual([]);
  });

  it('links a bill paid a few days early or late', () => {
    expect(find([payment({ date: '2026-08-01' })])).toHaveLength(1);
    expect(find([payment({ date: '2026-08-14' })])).toHaveLength(1);
  });

  it('refuses a payment too far from the due date to be that bill', () => {
    // 2026-08-20 is 14 days out — beyond the window.
    expect(find([payment({ date: '2026-08-20' })])).toEqual([]);
  });

  it('refuses a partial payment', () => {
    expect(find([payment({ amount: 100 })])).toEqual([]);
  });

  it('refuses a payment from a different envelope', () => {
    expect(find([payment({ envelope_id: 'other' })])).toEqual([]);
  });

  it('refuses an inflow — a fill or refund never settles a bill', () => {
    const refund = {
      id: 'r1', type: 'fill', date: '2026-08-06', status: 'posted',
      lines: [{ envelope_id: 'metsa', mode: 'add', amount: 183.6 }],
    };
    expect(find([refund])).toEqual([]);
  });

  it('refuses to guess between two identical payments for one bill', () => {
    // The un-cleaned double-booking. Neither row is knowably "the" payment.
    const out = find([payment(), payment({ id: 'x-aug-dup' })]);
    expect(out).toEqual([]);
  });

  it('proposes the survivor once the duplicate is deleted', () => {
    expect(find([payment({ id: 'x-aug-dup' })])).toHaveLength(1);
  });

  it('refuses when one payment could settle either of two bills', () => {
    const twin = { ...TAX_ITEM, id: 'bi-twin', description: 'Twin bill' };
    const out = find([payment()], { budgetItems: [TAX_ITEM, twin] });
    expect(out).toEqual([]);
  });

  it('ignores items whose envelope is archived or unresolved', () => {
    const orphanEnv = { ...TAX_ITEM, id: 'bi-gone', envelope_id: 'gone' };
    const missing = { ...TAX_ITEM, id: 'bi-missing', envelope_id: 'nope' };
    const out = find([payment({ envelope_id: 'gone' })], {
      budgetItems: [orphanEnv, missing],
    });
    expect(out).toEqual([]);
  });

  it('ignores income and investment items — only expenses are linked here', () => {
    const income = { ...TAX_ITEM, id: 'bi-inc', kind: 'income' };
    const invest = { ...TAX_ITEM, id: 'bi-inv', kind: 'investment_transfer' };
    expect(find([payment()], { budgetItems: [income, invest] })).toEqual([]);
  });

  it('ignores an excluded item', () => {
    expect(find([payment()], { budgetItems: [{ ...TAX_ITEM, include: false }] })).toEqual([]);
  });

  it('scopes to one envelope when asked', () => {
    expect(find([payment()], { envelopeId: 'other' })).toEqual([]);
    expect(find([payment()], { envelopeId: 'metsa' })).toHaveLength(1);
  });

  it('stays inside the occurrence window the materialiser uses', () => {
    // With no `as_schedule_since` the window opens on the 1st of THIS month,
    // so a July occurrence is neither charged nor postable — and not linkable.
    const july = {
      ...TAX_ITEM, id: 'bi-jul',
      monthly_schedule: { ...NO_MONTHS, Jul: 183.6 },
    };
    const out = find([payment({ date: '2026-07-06' })], { budgetItems: [july] });
    expect(out).toEqual([]);

    // `as_schedule_since` opens it back up, exactly as it does for the backlog.
    const backdated = { ...july, as_schedule_since: '2026-07-01' };
    expect(find([payment({ date: '2026-07-06' })], { budgetItems: [backdated] }))
      .toHaveLength(1);
  });

  // What the repair is FOR. The sheet applies proposals by writing `key` onto
  // the named transaction; this pins that the write actually settles the bill
  // on both surfaces that were reading it wrong.
  describe('applying a proposal', () => {
    const apply = (txs, proposals) => {
      const keyByTxId = new Map(proposals.map(p => [p.txId, p.key]));
      return txs.map(tx => (
        keyByTxId.has(tx.id) ? { ...tx, from_budget: keyByTxId.get(tx.id) } : tx
      ));
    };

    it('clears the phantom backlog from the projection', () => {
      const before = [payment()];
      const projectInput = {
        envelopeId: 'metsa', budgetItems: [TAX_ITEM], envelopeTemplates: [],
        accounts: [{ id: 'a1', name: 'Checking', type: 'bank' }],
        envelopes: ENVELOPES, today: TODAY, months: 12, tombstones: [],
      };

      const after = apply(before, find(before));
      expect(after[0].from_budget).toBe('bi-tax:2026-08');
      expect(projectEnvelopeBalance({ ...projectInput, transactions: after }).dueUnposted)
        .toBe(0);
    });

    it('stops post-due materialising a duplicate for that occurrence', () => {
      const before = [payment()];

      // Unlinked, the materialiser sees no key for 2026-08 and posts one.
      const dup = materializeDueBudgetItems(
        [TAX_ITEM], [{ id: 'a1', name: 'Checking', type: 'bank' }], ENVELOPES,
        before, TODAY, () => 'dup-1', [], 'FI', [],
      ).newTxs;
      expect(dup.map(tx => tx.from_budget)).toContain('bi-tax:2026-08');

      // Linked, it correctly does nothing — no second 183.60 in August.
      const after = apply(before, find(before));
      const none = materializeDueBudgetItems(
        [TAX_ITEM], [{ id: 'a1', name: 'Checking', type: 'bank' }], ENVELOPES,
        after, TODAY, () => 'dup-2', [], 'FI', [],
      ).newTxs;
      expect(none.map(tx => tx.from_budget)).not.toContain('bi-tax:2026-08');
    });

    it('lets the open-time post skip an occurrence paid early by hand (runDueScheduled)', () => {
      // Paid three days before the due date, recorded by hand, no key.
      const early = [payment({ date: '2026-08-03' })];
      const accounts = [{ id: 'a1', name: 'Checking', type: 'bank' }];
      // runDueScheduled passes the matcher's keys to the materialiser as
      // tombstones for this run only: nothing is written, nothing posted.
      const skip = find(early, { accounts }).map(p => p.key);
      expect(skip).toEqual(['bi-tax:2026-08']);
      const posted = materializeDueBudgetItems(
        [TAX_ITEM], accounts, ENVELOPES, early, TODAY, () => 'dup-3', [], 'FI', skip,
      ).newTxs;
      expect(posted.map(tx => tx.from_budget)).not.toContain('bi-tax:2026-08');
      // Two plausible payments are ambiguous: no skip, the post goes ahead
      // and the user sorts it out, as before.
      const two = [payment({ id: 'p1', date: '2026-08-03' }), payment({ id: 'p2', date: '2026-08-07' })];
      expect(find(two, { accounts })).toEqual([]);
    });

    it('is idempotent — a second scan finds nothing left to link', () => {
      const before = [payment()];
      const after = apply(before, find(before));
      expect(find(after)).toEqual([]);
    });
  });

  it('returns proposals oldest due date first', () => {
    const sept = {
      ...TAX_ITEM, id: 'bi-sep', description: 'Second bill',
      as_schedule_since: '2026-07-01',
      monthly_schedule: { ...NO_MONTHS, Jul: 50 },
    };
    const out = find(
      [payment(), payment({ id: 'x-jul', date: '2026-07-06', amount: 50 })],
      { budgetItems: [TAX_ITEM, sept] },
    );

    expect(out.map(p => p.dueDate)).toEqual(['2026-07-06', '2026-08-06']);
  });
});
