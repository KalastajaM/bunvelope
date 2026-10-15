// Fill %: how an envelope's balance is split across its budget items, and
// whether each will be paid on its due date by the envelope's projection.
// The fixtures are the owner's own examples (2026-10-01): car charging (an
// Evenli invoice plus misc charging), groceries, and the Insurances envelope
// whose statuses first read "short" while the envelope was on track.
import { describe, it, expect } from 'vitest';
import { computeItemFunding, computeItemFundingByEnvelope, resolveFundingStyle } from '../js/engine/item-funding.js';
import { projectEnvelopeBalance } from '../js/engine/envelope-forecast.js';

const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const only = (...months) => Object.fromEntries(months.map(m => [m, true]));
const today = new Date(2026, 9, 10); // 10 Oct 2026

const item = (id, envelope_id, default_amount, extra = {}) => ({
  id, envelope_id, description: id, kind: 'expense', default_amount,
  monthly_schedule: ALL, payment_day: 1, include: true, ...extra,
});
const spend = (id, date, amount, extra = {}) => ({
  id, type: 'expense', date, amount, envelope_id: extra.envelope_id || 'car', account: 'chk', status: 'posted', ...extra,
});
const byId = (res) => Object.fromEntries(res.items.map(i => [i.itemId, i]));

const carItems = [
  item('evenli', 'car', 50, { payment_day: 20, funding_style: 'bill' }),
  item('misc', 'car', 75, { funding_style: 'spending' }),
];
const car = (balance, transactions = [], extra = {}) => computeItemFunding({
  envelopeId: 'car', budgetItems: extra.items || carItems, transactions, balance, today, ...extra,
});

describe('car charging: the bill is funded before misc', () => {
  it('125 saves both in full', () => {
    const r = byId(car(125));
    // The whole Evenli invoice is in the envelope: fully funded. Spending has
    // no such moment, so misc stays on track.
    expect(r.evenli).toMatchObject({ allocated: 50, status: 'funded', pct: 1 });
    expect(r.misc).toMatchObject({ allocated: 75, status: 'on_track', pct: 1 });
  });

  it('a partly saved bill the fills will cover is on track, not funded', () => {
    expect(byId(car(30)).evenli).toMatchObject({ allocated: 30, status: 'on_track' });
  });

  it('100 saves Evenli first; misc has 50 of 75', () => {
    const res = car(100);
    const r = byId(res);
    expect(r.evenli.allocated).toBe(50);
    expect(r.misc.allocated).toBe(50);
    expect(r.misc.pct).toBeCloseTo(2 / 3, 5);
    expect(res.unassigned).toBe(0);
  });

  it('the status is the projection\'s: short only where it dips below the floor', () => {
    // Evenli is paid on the 20th with 50 left; misc spending then runs the
    // envelope to −25 by the 31st, and nothing refills it before then.
    const daily = [
      { date: '2026-10-10', balance: 100 },
      { date: '2026-10-20', balance: 50 },
      { date: '2026-10-31', balance: -25 },
      { date: '2026-11-01', balance: 100 },
    ];
    const res = car(100, [], { daily });
    const r = byId(res);
    expect(r.evenli).toMatchObject({ status: 'funded', shortBy: 0, shortDate: null });
    expect(r.misc).toMatchObject({ status: 'short', shortBy: 25, shortDate: '2026-10-31' });
    expect(res.shortfall).toBe(25);
    // Without a projection nothing can be judged short.
    expect(byId(car(100)).misc.status).toBe('on_track');
  });

  it('a bill is short by the projected gap on its due date', () => {
    const daily = [{ date: '2026-10-10', balance: 40 }, { date: '2026-10-20', balance: -10 }];
    expect(byId(car(40, [], { daily })).evenli).toMatchObject({ status: 'short', shortBy: 10, shortDate: '2026-10-20' });
  });

  it('lists the bill first', () => {
    expect(car(100).items.map(i => i.itemId)).toEqual(['evenli', 'misc']);
  });

  it('an exact untagged payment near the due date pays the bill', () => {
    const r = byId(car(75, [spend('t1', '2026-10-10', 50)]));
    expect(r.evenli).toMatchObject({ spent: 50, remaining: 0, status: 'paid' });
    expect(r.evenli.nextDue).toEqual({ date: '2026-11-20', amount: 50 });
    expect(r.misc).toMatchObject({ spent: 0, allocated: 75, status: 'on_track' });
  });

  it('a higher invoice left untagged lands on misc; linked, it pays Evenli', () => {
    const untagged = byId(car(63, [spend('t1', '2026-10-09', 62)]));
    expect(untagged.misc).toMatchObject({ spent: 62, remaining: 13 });
    expect(untagged.evenli).toMatchObject({ remaining: 50, allocated: 50, status: 'funded' });

    const linked = byId(car(63, [spend('t1', '2026-10-09', 62, { budget_item_id: 'evenli' })]));
    expect(linked.evenli).toMatchObject({ spent: 62, overspent: 12, status: 'paid' });
    expect(linked.misc).toMatchObject({ remaining: 75, allocated: 63 });
  });

  it('a from_budget key pays its item', () => {
    const r = byId(car(75, [spend('t1', '2026-10-03', 49, { from_budget: 'evenli:2026-10' })]));
    expect(r.evenli.status).toBe('paid');
  });

  it('a tombstoned or skipped occurrence counts as settled', () => {
    expect(byId(car(75, [], { tombstones: ['evenli:2026-10'] })).evenli).toMatchObject({ remaining: 0, status: 'paid' });
    const skipped = [item('evenli', 'car', 50, { funding_style: 'bill', payment_day: 20, skipped_occurrences: ['2026-10'] }), carItems[1]];
    expect(byId(car(75, [], { items: skipped })).evenli.remaining).toBe(0);
  });

  it('only this month up to today counts as spent', () => {
    const r = byId(car(125, [
      spend('old', '2026-09-28', 30),
      spend('future', '2026-10-25', 30),
    ]));
    expect(r.misc.spent).toBe(0);
  });

  it('the reserve comes after this month\'s amounts, and the rest is unassigned', () => {
    const items = [carItems[0], item('misc', 'car', 75, { funding_style: 'spending', extra_buffer: 30 })];
    const res = car(200, [], { items });
    expect(res).toMatchObject({ reserve: 30, reserveAllocated: 30, unassigned: 45 });
    const tight = car(140, [], { items });
    expect(tight).toMatchObject({ reserveAllocated: 15, unassigned: 0 });
  });

  it('the reserve is the floor the projection is judged against', () => {
    const items = [carItems[0], item('misc', 'car', 75, { funding_style: 'spending', extra_buffer: 30 })];
    const daily = [{ date: '2026-10-10', balance: 200 }, { date: '2026-10-20', balance: 20 }];
    expect(byId(car(200, [], { items, daily })).evenli).toMatchObject({ status: 'short', shortBy: 10 });
  });

  it('a negative balance saves nothing', () => {
    expect(car(-20).items.every(i => i.allocated === 0)).toBe(true);
  });
});

describe('groceries: a spending item runs down through the month', () => {
  const groceries = [item('groc', 'food', 400, { funding_style: 'spending' })];
  const run = (balance, txs) => byId(computeItemFunding({
    envelopeId: 'food', budgetItems: groceries, transactions: txs, balance, today,
  })).groc;

  it('300 spent leaves 100 of 400, which the balance covers', () => {
    const g = run(100, [spend('a', '2026-10-02', 120, { envelope_id: 'food' }), spend('b', '2026-10-08', 180, { envelope_id: 'food' })]);
    expect(g).toMatchObject({ planThisMonth: 400, spent: 300, remaining: 100, allocated: 100, status: 'on_track', pct: 1 });
  });

  it('spending past the allowance reads over', () => {
    const g = run(0, [spend('a', '2026-10-02', 450, { envelope_id: 'food' })]);
    expect(g).toMatchObject({ spent: 450, overspent: 50, remaining: 0, status: 'over' });
  });

  it('overspent but still covered by the envelope reads over, not short', () => {
    // 450 spent of a 400 plan; 1100 stays in the envelope and never dips.
    const daily = [{ date: '2026-10-08', balance: 1100 }, { date: '2026-10-31', balance: 1100 }];
    const g = byId(computeItemFunding({
      envelopeId: 'food', budgetItems: groceries, today, balance: 1100, daily,
      transactions: [spend('a', '2026-10-02', 450, { envelope_id: 'food' })],
    })).groc;
    expect(g).toMatchObject({ overspent: 50, shortBy: 0, status: 'over' });
  });

  it('overspent and leaving the envelope below its floor reads short', () => {
    const items = [item('groc', 'food', 400, { funding_style: 'spending', extra_buffer: 100 })];
    const daily = [{ date: '2026-10-08', balance: 300 }, { date: '2026-10-20', balance: 40 }];
    // 350 spent of 400 leaves 50 to spend this month, and the projection dips to 40.
    const under = byId(computeItemFunding({
      envelopeId: 'food', budgetItems: items, today, balance: 300, daily,
      transactions: [spend('a', '2026-10-02', 350, { envelope_id: 'food' })],
    })).groc;
    expect(under).toMatchObject({ status: 'short', shortBy: 60 });
    // Past the plan, still short: short wins over over.
    const over = byId(computeItemFunding({
      envelopeId: 'food', budgetItems: items, today, balance: 300, daily,
      transactions: [spend('a', '2026-10-02', 450, { envelope_id: 'food' })],
    })).groc;
    expect(over).toMatchObject({ overspent: 50, status: 'short', shortBy: 60 });
  });

  it('a refund linked to the item lowers what it spent', () => {
    const g = run(250, [
      spend('a', '2026-10-02', 200, { envelope_id: 'food', budget_item_id: 'groc' }),
      { id: 'r', type: 'expense', date: '2026-10-05', amount: 0, envelope_id: null, account: 'chk',
        envelope_splits: [{ envelope_id: 'food', amount: -50 }], budget_item_id: 'groc' },
    ]);
    expect(g.spent).toBe(150);
  });
});

describe('a split expense, each line linked to its own item', () => {
  // Two items in one envelope: unlinked spend goes to the spending item
  // first, so only the line's own link can put it on the bill.
  const items = [item('groc', 'food', 400, { funding_style: 'spending' }), item('bulk', 'food', 100, { funding_style: 'bill', payment_day: 20 })];
  const run = (txs) => byId(computeItemFunding({ envelopeId: 'food', budgetItems: items, transactions: txs, balance: 300, today }));
  const split = (link) => ({
    id: 's', type: 'expense', date: '2026-10-04', amount: 150, envelope_id: null, account: 'chk', status: 'posted',
    envelope_splits: [{ envelope_id: 'food', amount: 100, ...(link ? { budget_item_id: link } : {}) }, { envelope_id: 'fun', amount: 50 }],
  });

  it('counts the line against the item it names', () => {
    expect(run([split('bulk')])).toMatchObject({ bulk: { spent: 100 }, groc: { spent: 0 } });
  });

  it('without a link the line is ordinary spending', () => {
    expect(run([split(null)])).toMatchObject({ bulk: { spent: 0 }, groc: { spent: 100 } });
  });
});

describe('insurances: on track means the projection pays every premium on its date', () => {
  // The owner's envelope on 10 Oct 2026, as reported: a monthly AIG premium
  // (paid this month), two premiums due 2 Nov, one 15 Feb, one 7 May, and a
  // balance of 2,772.82 filled each month at the plan rate (annual ÷ 12).
  // The first fill % version called the Feb and May premiums short; the
  // envelope never dips below zero, so none is.
  const ins = [
    item('aig', 'ins', 15.29, { payment_day: 2, description: 'AIG' }),
    item('op1', 'ins', 1818.51, { monthly_schedule: only('Nov'), payment_day: 2 }),
    item('terveys', 'ins', 128.72, { monthly_schedule: only('Nov'), payment_day: 2 }),
    item('op2', 'ins', 1543.54, { monthly_schedule: only('Feb'), payment_day: 15 }),
    item('op3', 'ins', 2132.89, { monthly_schedule: only('May'), payment_day: 7 }),
  ];
  const annual = 15.29 * 12 + 1818.51 + 128.72 + 1543.54 + 2132.89;
  const monthlyFill = Math.round(annual / 12 * 100) / 100; // 483.93
  const ENV = [{ id: 'ins', name: 'Insurances' }];
  const opening = { id: 'f0', type: 'fill', date: '2026-10-01', status: 'posted', lines: [{ envelope_id: 'ins', mode: 'add', amount: 2788.11 }] };
  const aigPaid = spend('aig-oct', '2026-10-02', 15.29, { envelope_id: 'ins', budget_item_id: 'aig' });

  const run = (fill) => {
    const txs = [opening, aigPaid];
    const tpl = { id: 'tpl', lines: [{ envelope_id: 'ins', mode: 'add', amount: fill }], schedule: { enabled: true, payment_day: 1, months: ALL } };
    const projection = projectEnvelopeBalance({
      envelopeId: 'ins', transactions: txs, budgetItems: ins, envelopeTemplates: [tpl],
      accounts: [{ id: 'chk', name: 'Checking', type: 'bank' }], envelopes: ENV,
      today, months: 12, country: 'FI', tombstones: [],
    });
    const res = computeItemFunding({
      envelopeId: 'ins', budgetItems: ins, transactions: txs, balance: 2772.82, today, daily: projection.daily,
    });
    return { projection, res, r: byId(res) };
  };

  it('defaults every premium to a bill', () => {
    expect(ins.map(resolveFundingStyle)).toEqual(['bill', 'bill', 'bill', 'bill', 'bill']);
  });

  it('at the plan rate the envelope never dips, so nothing is short', () => {
    const { projection, res, r } = run(monthlyFill);
    expect(projection.low.balance).toBeGreaterThanOrEqual(0);
    expect(res.items.map(i => [i.itemId, i.status])).toEqual([
      // AIG paid; both November premiums already in full; Feb and May partly
      // saved, the fills covering the rest.
      ['aig', 'paid'], ['op1', 'funded'], ['terveys', 'funded'], ['op2', 'on_track'], ['op3', 'on_track'],
    ]);
    expect(res.shortfall).toBe(0);
    // What is already in the envelope, earliest due first: everything due
    // 2 Nov in full (AIG's next premium too), the rest towards February; May
    // waits for the fills.
    expect(r.aig.allocated).toBe(15.29);
    expect(r.op1.allocated).toBe(1818.51);
    expect(r.terveys.allocated).toBe(128.72);
    expect(r.op2.allocated).toBe(round(2772.82 - 15.29 - 1818.51 - 128.72));
    expect(r.op3.allocated).toBe(0);
  });

  it('with too small a fill, an item is short by exactly the projected gap on its date', () => {
    const { projection, res } = run(100);
    const short = res.items.filter(i => i.status === 'short');
    expect(short.length).toBeGreaterThan(0);
    for (const i of short) {
      const point = projection.daily.filter(p => p.date <= i.shortDate).at(-1);
      expect(i.shortBy).toBe(round(-point.balance));
      expect(i.shortDate).toBe(i.nextDue.date);
    }
    expect(res.shortfall).toBe(Math.max(...short.map(i => i.shortBy)));
  });
});

const round = (n) => Math.round(n * 100) / 100;

describe('style and scope', () => {
  it('resolves the funding style', () => {
    expect(resolveFundingStyle({ id: 'a', funding_style: 'spending', as_schedule: true })).toBe('spending');
    expect(resolveFundingStyle({ id: 'a', as_schedule: true, monthly_schedule: ALL })).toBe('bill');
    expect(resolveFundingStyle({ id: 'a', monthly_schedule: ALL })).toBe('spending');
    expect(resolveFundingStyle({ id: 'a', monthly_schedule: ALL, payment_day: 1 })).toBe('spending');
    expect(resolveFundingStyle({ id: 'a', monthly_schedule: ALL, payment_day: 8 })).toBe('bill');
    expect(resolveFundingStyle({ id: 'a', monthly_schedule: { ...ALL, Jul: false } })).toBe('bill');
    expect(resolveFundingStyle(null)).toBe('bill');
  });

  it('ignores income, transfers, disabled items and other envelopes', () => {
    const items = [
      ...carItems,
      item('pay', 'car', 100, { kind: 'income' }),
      item('xfer', 'car', 100, { kind: 'account_transfer' }),
      item('off', 'car', 100, { include: false }),
      item('elsewhere', 'food', 100),
    ];
    expect(car(500, [], { items }).items.map(i => i.itemId).sort()).toEqual(['evenli', 'misc']);
  });

  it('a link to an item of another envelope never pays an item here', () => {
    const res = car(125, [spend('t1', '2026-10-05', 20, { budget_item_id: 'groc' })]);
    expect(byId(res).misc.spent).toBe(0);
    expect(res.unlinkedSpent).toBe(20);
  });

  it('a bill paid in the days before the 1st settles this month', () => {
    const linked = byId(car(75, [spend('t1', '2026-09-28', 47, { budget_item_id: 'evenli' })]));
    // Evenli is due 20 Oct: 28 Sep is outside the link window, so it does not count.
    expect(linked.evenli.status).toBe('funded');
    const early = (date, extra) => byId(computeItemFunding({
      envelopeId: 'car', transactions: [spend('t1', date, 50, extra)], balance: 75, today,
      budgetItems: [item('evenli', 'car', 50, { payment_day: 3, funding_style: 'bill' }), carItems[1]],
    })).evenli;
    // Due 3 Oct: a payment on 28 Sep is within the window, linked or exact.
    expect(early('2026-09-28', { budget_item_id: 'evenli' })).toMatchObject({ status: 'paid', spent: 0, remaining: 0 });
    expect(early('2026-09-28', {})).toMatchObject({ status: 'paid', spent: 0 });
    // Too early, and last month's spend never counts as this month's.
    expect(early('2026-09-10', { budget_item_id: 'evenli' })).toMatchObject({ status: 'funded', remaining: 50 });
  });

  it('requires a clock', () => {
    // @ts-ignore deliberately missing
    expect(() => computeItemFunding({ envelopeId: 'car', budgetItems: carItems, transactions: [], balance: 0 })).toThrow(/valid Date/);
  });

  it('batches over envelopes, skipping archived ones and envelopes without items', () => {
    const map = computeItemFundingByEnvelope({
      envelopes: [{ id: 'car' }, { id: 'food' }, { id: 'old', archived: true }],
      budgetItems: [...carItems, item('o', 'old', 10)],
      transactions: [spend('t1', '2026-10-05', 20)],
      balances: new Map([['car', 100]]),
      today,
    });
    expect([...map.keys()]).toEqual(['car']);
    expect(byId(map.get('car')).misc.spent).toBe(20);
  });
});

describe('invariant: a link must stay inside the row\'s envelope', async () => {
  const { runInvariantCheck } = await import('../js/engine/insights.js');
  const accounts = [{ id: 'chk' }];
  const envelopes = [{ id: 'car' }, { id: 'food' }];
  const budgetItems = [...carItems, item('groc', 'food', 400)];

  it('flags a link to an item of another envelope, not a deleted item or a good link', () => {
    const report = runInvariantCheck({
      accounts, envelopes, budgetItems,
      transactions: [
        spend('good', '2026-10-05', 20, { budget_item_id: 'misc' }),
        spend('gone', '2026-10-05', 20, { budget_item_id: 'deleted-item' }),
        spend('moved', '2026-10-05', 20, { budget_item_id: 'groc' }),
      ],
    });
    expect(report.byCategory.itemLinks).toBe(1);
    expect(report.problems.filter(p => p.category === 'itemLinks').map(p => p.id)).toEqual(['moved']);
    expect(report.problems.find(p => p.id === 'moved')).toMatchObject({ code: 'budgetItemOtherEnvelope', params: { item: 'groc' } });
  });

  it("flags a split line linked to an item of another line's envelope", () => {
    const split = (id, foodLink) => ({
      id, type: 'expense', date: '2026-10-05', amount: 30, envelope_id: null, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'car', amount: 20, budget_item_id: 'misc' }, { envelope_id: 'food', amount: 10, budget_item_id: foodLink }],
    });
    const report = runInvariantCheck({ accounts, envelopes, budgetItems, transactions: [split('ok', 'groc'), split('crossed', 'misc')] });
    expect(report.problems.filter(p => p.category === 'itemLinks').map(p => p.id)).toEqual(['crossed']);
  });

  it('skips the check when no budget items are passed', () => {
    const report = runInvariantCheck({ accounts, envelopes, transactions: [spend('moved', '2026-10-05', 20, { budget_item_id: 'groc' })] });
    expect(report.byCategory.itemLinks).toBe(0);
  });
});
