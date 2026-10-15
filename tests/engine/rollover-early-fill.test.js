// The month-end rollover acts on the month's own money, not on a fill for
// NEXT month that happens to land before the 1st (a day-1 template moved to
// the 31st by `prev_work_day`). Seen for real on 2026-08-31: a Start of Month
// fill was swept straight back to Unallocated by August's zero-monthly sweep.
import { describe, it, expect } from 'vitest';
import { applyEnvelopeRollovers, computeEnvelopeBalances, projectEnvelopeBalance } from '../../js/engine.js';

const env = (rollover) => [{ id: 'fun', name: 'Fun', rollover }];
const spend = { id: 's', type: 'expense', date: '2026-08-10', amount: 70, account: 'chk', envelope_id: 'fun', status: 'posted' };
const augFill = { id: 'f8', type: 'fill', date: '2026-08-01', lines: [{ envelope_id: 'fun', amount: 100 }], from_budget: 'tpl:som:2026-08', status: 'posted' };
// September's fill, paid on Mon 31 Aug because 1 Sep... (any early date will do)
const sepFillEarly = { id: 'f9', type: 'fill', date: '2026-08-31', lines: [{ envelope_id: 'fun', amount: 125 }], from_budget: 'tpl:som:2026-09', status: 'posted' };
const SEP1 = new Date(2026, 8, 1);
let n = 0;
const idGen = () => `r${++n}`;

const after = (txs, rollover) => {
  const { newTxs } = applyEnvelopeRollovers(env(rollover), txs, SEP1, idGen);
  return { newTxs, bal: computeEnvelopeBalances([...txs, ...newTxs]).get('fun') };
};

describe('zero-monthly with next month\'s fill dated early', () => {
  it('sweeps only August\'s remainder, and keeps September\'s fill', () => {
    const { newTxs, bal } = after([augFill, spend, sepFillEarly], 'zero-monthly');
    expect(newTxs.map(t => t.amount)).toEqual([-30]);
    expect(bal).toBe(125);
  });

  it('sweeps nothing when August ended at or below zero', () => {
    const over = { ...spend, amount: 100 };
    expect(after([augFill, over, sepFillEarly], 'zero-monthly').newTxs).toEqual([]);
  });

  it('a set-mode early fill already replaced the balance: nothing is left to sweep', () => {
    const setFill = { ...sepFillEarly, lines: [{ envelope_id: 'fun', amount: 125, mode: 'set' }] };
    const { newTxs, bal } = after([augFill, spend, setFill], 'zero-monthly');
    expect(newTxs).toEqual([]);
    expect(bal).toBe(125);
  });

  it('a fill for August itself, dated the 31st, is still August\'s money', () => {
    const lateAug = { ...sepFillEarly, from_budget: 'tpl:end:2026-08' };
    const { bal } = after([augFill, spend, lateAug], 'zero-monthly');
    expect(bal).toBe(0);
  });
});

describe('cover-from-unallocated with next month\'s fill dated early', () => {
  it('covers August\'s deficit even though the early fill hid it', () => {
    const over = { ...spend, amount: 150 }; // August ends at −50 before the fill
    const { newTxs, bal } = after([augFill, over, sepFillEarly], 'cover-from-unallocated');
    expect(newTxs.map(t => t.amount)).toEqual([50]);
    expect(bal).toBe(125);
  });
});

describe('the envelope projection mirrors it', () => {
  it('does not sweep a forecast fill for next month that lands on the last day', () => {
    const today = new Date(2026, 7, 20);
    const proj = projectEnvelopeBalance({
      envelopeId: 'fun',
      transactions: [augFill, spend, { ...sepFillEarly, status: 'scheduled' }],
      budgetItems: [], envelopeTemplates: [], accounts: [], envelopes: env('zero-monthly'),
      today, months: 1,
    });
    const sep1 = proj.daily.find(p => p.date === '2026-09-01');
    expect(sep1.balance).toBe(125);
  });
});

describe('working-day shifts apply to bills as well as fills', () => {
  const fund = { ...augFill, date: '2026-10-01', from_budget: 'tpl:som:2026-10' };
  const earlyBill = { ...spend, amount: 30, date: '2026-10-30', from_budget: 'bill:2026-11' };
  const lateBill = { ...spend, amount: 30, date: '2026-11-02', from_budget: 'bill:2026-10' };
  const november = new Date(2026, 10, 2);
  const project = (bill, day = 20) => projectEnvelopeBalance({
    envelopeId: 'fun', transactions: [fund, bill], envelopes: env('zero-monthly'),
    budgetItems: [], envelopeTemplates: [], accounts: [], today: new Date(2026, 9, day), months: 2,
  });

  it('preserves an early November bill through October’s sweep, even when already in the projection opening', () => {
    const { newTxs } = applyEnvelopeRollovers(env('zero-monthly'), [fund, earlyBill], november, idGen);
    expect(newTxs[0].amount).toBe(-100);
    for (const day of [20, 30, 31]) {
      expect(project(earlyBill, day).daily.find(x => x.date === '2026-11-02').balance).toBe(-30);
    }
  });

  it('reserves a late October bill in the projection and the posted rollover', () => {
    const { newTxs } = applyEnvelopeRollovers(env('zero-monthly'), [fund, lateBill], november, idGen);
    expect(newTxs[0].amount).toBe(-70);
    const p = project(lateBill);
    expect(p.daily.find(x => x.date === '2026-10-31').balance).toBe(30);
    expect(p.daily.find(x => x.date === '2026-11-02').balance).toBe(0);
  });
});


it('forecasts a generated next-working-day bill with the same reserved remainder', () => {
  const projection = projectEnvelopeBalance({
    envelopeId: 'fun', envelopes: env('zero-monthly'),
    accounts: [{ id: 'chk', type: 'bank' }], envelopeTemplates: [],
    transactions: [{ ...augFill, date: '2026-10-01', from_budget: 'tpl:som:2026-10' }],
    budgetItems: [{ id: 'bill', kind: 'expense', envelope_id: 'fun', account_id: 'chk',
      as_schedule: true, as_schedule_since: '2026-10-01', end_month: '2026-10',
      monthly_schedule: { Oct: true }, default_amount: -30, payment_day: 31,
      schedule_day_type: 'next_work_day', include: true }],
    today: new Date(2026, 9, 20), months: 2,
  });
  expect(projection.daily.find(x => x.date === '2026-10-31').balance).toBe(30);
  expect(projection.daily.find(x => x.date === '2026-11-02').balance).toBe(0);
});
