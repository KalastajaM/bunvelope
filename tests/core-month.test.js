import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { computeEnvelopeBalances } from '../js/engine/balances.js';
import { postDueRows } from '../js/core/commands/month-post-due.js';
import { rolloverRows } from '../js/core/commands/month-rollover.js';
import { occurrenceMonthOf } from '../js/core/commands/month-start.js';
import { materializeDueBudgetItems, materializeDueTemplateFills } from '../js/engine/scheduling.js';
import { findUnlinkedScheduledPayments } from '../js/engine/envelope-forecast.js';
import { applyEnvelopeRollovers } from '../js/engine/policies.js';
import strictLedger from '../js/core/policies/strict-ledger.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 15, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const rentItem = (over = {}) => ({
  id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'env', account_id: 'chk',
  as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
  default_amount: -100, payment_day: 5, schedule_day_type: 'exact', include: true, ...over,
});
const template = (over = {}) => ({
  id: 'tpl', name: 'Start of month', kind: 'manual',
  lines: [{ envelope_id: 'env', mode: 'add', amount: 30 }],
  schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS },
  ...over,
});
const data = (over = {}) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'env', name: 'Rent' }],
  transactions: [],
  ...over,
});
const run = (name, d, input = {}, opts) => runCommand(registry, d, name, input, ctx(), opts);
const apply = (d, r) => ({ ...d, ...r.value.changes });

describe('month.postDue', () => {
  it('posts a due monthly budget item once, and a second run posts nothing', () => {
    const d = data({ budgetItems: [rentItem()] });
    const r1 = run('month.postDue', d);
    expect(r1.ok).toBe(true);
    expect(r1.value.value.posted).toBe(1);
    expect(r1.value.value.rows[0]).toMatchObject({ type: 'expense', date: '2026-10-05', from_budget: 'rent:2026-10', amount: 100 });
    expect(r1.value.changes.transactions).toHaveLength(1);

    const r2 = run('month.postDue', apply(d, r1));
    expect(r2.ok).toBe(true);
    expect(r2.value.value.posted).toBe(0);
    expect(r2.value.changes).toEqual({});
  });

  it('does not post a tombstoned key', () => {
    const d = data({ meta: { scheduledTombstones: ['rent:2026-10'] }, budgetItems: [rentItem()] });
    const r = run('month.postDue', d);
    expect(r.value.value.posted).toBe(0);
    // Control: the same data without the tombstone posts the row.
    const control = run('month.postDue', data({ budgetItems: [rentItem()] }));
    expect(control.value.value.rows.map(x => x.from_budget)).toEqual(['rent:2026-10']);
  });

  it('does not post an occurrence a hand-recorded payment settles', () => {
    const hand = { id: 'h', type: 'expense', date: '2026-10-04', status: 'posted', amount: 100, envelope_id: 'env', account: 'chk', payee: 'Landlord' };
    const d = data({ budgetItems: [rentItem()], transactions: [hand] });
    const r = run('month.postDue', d);
    expect(r.value.value.posted).toBe(0);
    // Control: the same data without the hand payment posts the row.
    const control = run('month.postDue', data({ budgetItems: [rentItem()] }));
    expect(control.value.value.rows.map(x => x.from_budget)).toEqual(['rent:2026-10']);
  });

  it('posts a self-scheduled template fill with a tpl: from_budget key', () => {
    const d = data({ envelopeTemplates: [template()] });
    const r = run('month.postDue', d);
    expect(r.value.value.posted).toBe(1);
    expect(r.value.value.rows[0]).toMatchObject({ type: 'fill', from_budget: 'tpl:tpl:2026-10', date: '2026-10-01' });
  });

  it('marks every row cleared when cleared is true, and leaves them unmarked otherwise', () => {
    const d = data({ budgetItems: [rentItem()], envelopeTemplates: [template()] });
    const marked = run('month.postDue', d, { cleared: true });
    expect(marked.value.value.rows).toHaveLength(2);
    expect(marked.value.value.rows.every(r => r.cleared === true)).toBe(true);
    const plain = run('month.postDue', d);
    expect(plain.value.value.rows.some(r => r.cleared === true)).toBe(false);
  });

  it('does not apply payee aliases to the rows it posts', () => {
    const d = data({ meta: { payeeAliases: { rent: 'Landlord' } }, budgetItems: [rentItem()] });
    const r = run('month.postDue', d, {}, { checks: applyCommitChecks });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions[0].payee).toBe('Rent');
    // Control: a command that does not opt out would have had it aliased.
    const aliased = applyCommitChecks(d, { transactions: [{ id: 'x', type: 'expense', amount: 1, date: '2026-10-01', account: 'chk', envelope_id: 'env', payee: 'rent' }] });
    expect(aliased.value.transactions[0].payee).toBe('Landlord');
  });

  it('uses input.date as the reference date', () => {
    const d = data({ budgetItems: [rentItem({ as_schedule_since: '2026-09-01' })] });
    const early = run('month.postDue', d, { date: '2026-09-20' });
    expect(early.value.value.rows.map(r => r.from_budget)).toEqual(['rent:2026-09']);
    const later = run('month.postDue', d, { date: '2026-10-20' });
    expect(later.value.value.rows.map(r => r.from_budget)).toEqual(['rent:2026-09', 'rent:2026-10']);
  });
});

describe('month.rollover', () => {
  const sweepData = (over = {}) => data({
    envelopes: [{ id: 'groc', name: 'Groceries', rollover: 'zero-monthly' }],
    transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-09-10', status: 'posted', amount: 50, from_envelope_id: null, to_envelope_id: 'groc' }],
    ...over,
  });

  it('sweeps a zero-monthly envelope into an adjustment dated the last day of the previous month, once', () => {
    const d = sweepData();
    const r1 = run('month.rollover', d);
    expect(r1.ok).toBe(true);
    expect(r1.value.value.adjusted).toBe(1);
    expect(r1.value.value.rows[0]).toMatchObject({ type: 'adjustment', date: '2026-09-30', amount: -50, from_budget: 'rollover:groc:2026-09' });

    const r2 = run('month.rollover', apply(d, r1));
    expect(r2.value.value.adjusted).toBe(0);
    expect(r2.value.changes).toEqual({});
  });

  it('marks rows cleared when asked', () => {
    const r = run('month.rollover', sweepData(), { cleared: true });
    expect(r.value.value.rows.every(x => x.cleared === true)).toBe(true);
  });

  it('uses input.date as the reference month', () => {
    const none = run('month.rollover', sweepData(), { date: '2026-09-20' });
    expect(none.value.value.adjusted).toBe(0);
    const r = run('month.rollover', sweepData(), { date: '2026-10-02' });
    expect(r.value.value.rows[0].from_budget).toBe('rollover:groc:2026-09');
  });

  it('does not re-sweep a tombstoned key', () => {
    const r = run('month.rollover', sweepData({ meta: { scheduledTombstones: ['rollover:groc:2026-09'] } }));
    expect(r.value.value.adjusted).toBe(0);
  });
});

describe('month.start', () => {
  // Nov 1 2026 is a Sunday: a day-1, prev_work_day fill is dated Fri Oct 30,
  // i.e. into the month the rollover is about to close.
  // `since: '2026-11-01'` stands in for "October's fill was already posted": the
  // schedule window then owns only November's occurrence, so the only fill due
  // is the one that is dated in October.
  const orderData = () => data({
    envelopes: [{ id: 'groc', name: 'Groceries', rollover: 'zero-monthly' }],
    transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 100, from_envelope_id: null, to_envelope_id: 'groc' }],
    envelopeTemplates: [template({
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 300 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-11-01', months: ALL_MONTHS },
    })],
  });
  const grocBalance = (txs) => computeEnvelopeBalances(txs, { asOf: new Date(2026, 10, 30) }).get('groc');

  it('keeps a fill that belongs to the new month out of the sweep, though it is dated in the closing month', () => {
    const d = orderData();
    const r = run('month.start', d, { date: '2026-11-02' });
    expect(r.ok).toBe(true);
    const { adjusted, posted, rows } = r.value.value;
    expect(adjusted).toBe(1);
    expect(posted).toBe(1);
    const sweep = rows.find(x => x.type === 'adjustment');
    const fill = rows.find(x => x.type === 'fill');
    expect(sweep).toMatchObject({ amount: -100, date: '2026-10-31', from_budget: 'rollover:groc:2026-10' });
    expect(fill).toMatchObject({ date: '2026-10-30', from_budget: 'tpl:tpl:2026-11' });
    expect(r.value.changes.transactions).toEqual([...d.transactions, ...rows]);
    expect(grocBalance(r.value.changes.transactions)).toBe(300);
  });

  // Before #301 posting first swept this fill away (-400, balance 0): the
  // engine read October's balance with November's early fill in it. Since #301
  // the engine leaves a fill keyed to a later month out of the month it closes,
  // so post-due-first agrees with month.start here; only rollover-first is
  // still wrong (the mirror case below).
  it('agrees with post-due-first for this case since #301: the engine itself leaves the early fill out', () => {
    const d = orderData();
    const input = { date: '2026-11-02' };
    const postFirst = postDueRows(d, input, ctx());
    const withFill = { ...d, transactions: [...d.transactions, ...postFirst] };
    const sweepAfter = rolloverRows(withFill, input, ctx());
    expect(sweepAfter[0].amount).toBe(-100);
    expect(grocBalance([...withFill.transactions, ...sweepAfter])).toBe(300);
  });

  // A set-mode early fill replaces the balance, so there is nothing left to
  // sweep. month.start hands later-month fills to the sweep for exactly this:
  // kept out of it, the sweep took October's 100 off a balance the fill had
  // already set (300 → 200; a cover made it 400).
  it.each(['zero-monthly', 'cover-from-unallocated'])('lands a set-mode early fill on its target (%s)', (policy) => {
    const base = orderData();
    const d = deepFreeze({
      ...base,
      envelopes: [{ id: 'groc', name: 'Groceries', rollover: policy }],
      transactions: policy === 'zero-monthly' ? base.transactions
        : [{ ...base.transactions[0], from_envelope_id: 'groc', to_envelope_id: null }],
      envelopeTemplates: [{ ...base.envelopeTemplates[0], lines: [{ envelope_id: 'groc', mode: 'set', amount: 300 }] }],
    });
    const r = run('month.start', d, { date: '2026-11-02' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toMatchObject({ adjusted: 0, posted: 1 });
    expect(r.value.value.rows[0]).toMatchObject({ type: 'fill', date: '2026-10-30', from_budget: 'tpl:tpl:2026-11' });
    expect(grocBalance(r.value.changes.transactions)).toBe(300);
    // Stored add-only (owner decision 2026-10-04): the delta, with its target.
    expect(r.value.value.rows[0].lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: policy === 'zero-monthly' ? 200 : 400, set_target: 300 }]);
  });

  it('keeps an early fill whose set target is already met: a zero line, and the sweep leaves the target', () => {
    const base = orderData();
    const d = deepFreeze({
      ...base,
      transactions: [{ ...base.transactions[0], amount: 300 }],
      envelopeTemplates: [{ ...base.envelopeTemplates[0], lines: [{ envelope_id: 'groc', mode: 'set', amount: 300 }] }],
    });
    const r = run('month.start', d, { date: '2026-11-02' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toMatchObject({ adjusted: 0, posted: 1 });
    expect(r.value.value.rows[0].lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 0, set_target: 300 }]);
    expect(grocBalance(r.value.changes.transactions)).toBe(300);
  });

  it('is not blocked by the strict-ledger policy when a scheduled template has a set line', () => {
    const d = data({
      envelopes: [{ id: 'groc', name: 'Groceries' }],
      envelopeTemplates: [template({ lines: [{ envelope_id: 'groc', mode: 'set', amount: 250 }] })],
    });
    const r = run('month.start', d, {}, { policies: [strictLedger] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const fills = r.value.value.rows.filter(x => x.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every(f => f.lines.every(l => l.mode === 'add'))).toBe(true);
    expect(fills[0].lines[0]).toEqual({ envelope_id: 'groc', mode: 'add', amount: 250, set_target: 250 });
  });

  // The mirror case: a bill belonging to October (due Sat 31 Oct, exact), first
  // posted on an open on 2 Nov, must be in October's balance when the sweep
  // looks at it. Rollover-first would sweep 99.99 and then post the bill into a
  // balance of 0, carrying -30 into November.
  const lateBillData = (policy) => data({
    envelopes: [{ id: 'groc', name: 'Groceries', rollover: policy }],
    transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: policy === 'zero-monthly' ? 99.99 : 10, from_envelope_id: null, to_envelope_id: 'groc' }],
    budgetItems: [rentItem({ id: 'bill', envelope_id: 'groc', as_schedule_since: '2026-10-01', default_amount: -30, payment_day: 31, schedule_day_type: 'exact' })],
  });

  it('counts a bill belonging to the closing month in that month\'s sweep, though it is posted on this open', () => {
    const d = lateBillData('zero-monthly');
    const r = run('month.start', d, { date: '2026-11-02' });
    expect(r.ok).toBe(true);
    const bill = r.value.value.rows.find(x => x.type === 'expense');
    const sweep = r.value.value.rows.find(x => x.type === 'adjustment');
    expect(bill).toMatchObject({ date: '2026-10-31', amount: 30, from_budget: 'bill:2026-10' });
    expect(sweep).toMatchObject({ amount: -69.99, date: '2026-10-31', from_budget: 'rollover:groc:2026-10' });
    expect(grocBalance(r.value.changes.transactions)).toBe(0);
    expect(r.value.value).toMatchObject({ adjusted: 1, posted: 1 });
    expect(r.value.changes.transactions).toEqual([...d.transactions, bill, sweep]);
  });

  it('covers a deficit made by a closing-month bill on the same open', () => {
    const r = run('month.start', lateBillData('cover-from-unallocated'), { date: '2026-11-02' });
    const cover = r.value.value.rows.find(x => x.type === 'adjustment');
    expect(cover).toMatchObject({ amount: 20, date: '2026-10-31', from_budget: 'rollover:groc:2026-10' });
    expect(grocBalance(r.value.changes.transactions)).toBe(0);
  });

  it('documents why rollover-first is wrong for the mirror case: the bill lands in a swept balance', () => {
    const d = lateBillData('zero-monthly');
    const rollFirst = rolloverRows(d, { date: '2026-11-02' }, ctx());
    const bill = postDueRows({ ...d, transactions: [...d.transactions, ...rollFirst] }, { date: '2026-11-02' }, ctx());
    expect(grocBalance([...d.transactions, ...rollFirst, ...bill])).toBe(-30);
  });

  // The shared rollover engine now handles this case for every caller: a
  // non-fill row of a LATER month that a working-day adjustment dated in the
  // closing one. Nov 1 2026 is a Sunday, so a day-1 prev_work_day bill for
  // November is dated Fri 30 Oct. It belongs to November, so October's sweep
  // ignores it (sweeps all 100) and the bill then leaves November at -30.
  // Posting first and then rolling over must give the same result.
  it('does not count a later-month bill dated in the closing month in that month\'s sweep (shared engine rule)', () => {
    const d = data({
      envelopes: [{ id: 'groc', name: 'Groceries', rollover: 'zero-monthly' }],
      transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 100, from_envelope_id: null, to_envelope_id: 'groc' }],
      budgetItems: [rentItem({ id: 'bill', envelope_id: 'groc', as_schedule_since: '2026-11-01', default_amount: -30, payment_day: 1, schedule_day_type: 'prev_work_day' })],
    });
    const r = run('month.start', d, { date: '2026-11-02' });
    expect(r.ok).toBe(true);
    const bill = r.value.value.rows.find(x => x.type === 'expense');
    const sweep = r.value.value.rows.find(x => x.type === 'adjustment');
    expect(bill).toMatchObject({ date: '2026-10-30', amount: 30, from_budget: 'bill:2026-11' });
    expect(sweep).toMatchObject({ amount: -100, date: '2026-10-31', from_budget: 'rollover:groc:2026-10' });
    expect(grocBalance(r.value.changes.transactions)).toBe(-30);
    // The shared engine gives the same result when the bill was already posted.
    const postFirst = postDueRows(d, { date: '2026-11-02' }, ctx());
    const withBill = { ...d, transactions: [...d.transactions, ...postFirst] };
    expect(rolloverRows(withBill, { date: '2026-11-02' }, ctx())[0].amount).toBe(-100);
  });

  it('occurrenceMonthOf reads the month a row belongs to from its from_budget key', () => {
    expect(occurrenceMonthOf({ from_budget: 'rent:2026-10', date: '2026-11-02' })).toBe('2026-10');
    expect(occurrenceMonthOf({ from_budget: 'rent:2026-10:interest', date: '2026-11-02' })).toBe('2026-10');
    expect(occurrenceMonthOf({ from_budget: 'pay:2026-10:fill', date: '2026-11-02' })).toBe('2026-10');
    expect(occurrenceMonthOf({ from_budget: 'tpl:tpl:2026-11', date: '2026-10-30' })).toBe('2026-11');
    // The loan payment's fee leg (#304) is keyed like its interest leg.
    expect(occurrenceMonthOf({ from_budget: 'm:2026-11:fee', date: '2026-10-30' })).toBe('2026-11');
    expect(occurrenceMonthOf({ from_budget: 'we:ird', date: '2026-09-05' })).toBe('2026-09');
    expect(occurrenceMonthOf({ date: '2026-09-05' })).toBe('2026-09');
    expect(occurrenceMonthOf({})).toBeNull();
  });

  it('is idempotent: a second run posts and adjusts nothing', () => {
    const d = orderData();
    const r1 = run('month.start', d, { date: '2026-11-02' });
    const r2 = run('month.start', apply(d, r1), { date: '2026-11-02' });
    expect(r2.value.value).toMatchObject({ adjusted: 0, posted: 0 });
    expect(r2.value.changes).toEqual({});
  });

  it('marks every row cleared when asked', () => {
    const r = run('month.start', orderData(), { date: '2026-11-02', cleared: true });
    expect(r.value.value.rows.every(x => x.cleared === true)).toBe(true);
  });

  it('does not apply payee aliases to the rows it adds', () => {
    const d = { ...orderData(), meta: { schemaVersion: 8, payeeAliases: { 'rollover: sweep to unallocated': 'Sweep' } } };
    const r = run('month.start', d, { date: '2026-11-02' }, { checks: applyCommitChecks });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions.find(x => x.type === 'adjustment').payee).toBe('Rollover: sweep to unallocated');
    // Control: a command that does not opt out would have had it aliased.
    const aliased = applyCommitChecks(d, { transactions: [{ id: 'x', type: 'expense', amount: 1, date: '2026-10-01', account: 'chk', envelope_id: 'groc', payee: 'Rollover: sweep to unallocated' }] });
    expect(aliased.value.transactions[0].payee).toBe('Sweep');
  });

  // The loan leg keys (#299): principal `<item>:<month>`, interest
  // `<item>:<month>:interest`; a plan-linked (dynamic) template fills from the
  // plan with a `tpl:` key. An income-linked `:fill` leg is no longer emitted
  // by the materialiser (templates carry their own calendar), so the only
  // `:fill` handling is occurrenceMonthOf reading a legacy key.
  describe('loans and plan-linked fills', () => {
    // A flat-month day count, so the split is owed × rate ÷ 12 (300 / 700).
    const loanData = (over = {}) => data({
      accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 5000 }, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' }],
      envelopes: [{ id: 'housing', name: 'Housing' }],
      budgetItems: [{
        id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
        loan_rate: 3, default_amount: -1000, monthly_schedule: ALL_MONTHS, payment_day: 5, as_schedule: true,
        as_schedule_since: '2026-10-01', include: true, schedule_day_type: 'exact',
      }],
      ...over,
    });

    it('posts both legs of a loan payment, once', () => {
      const d = loanData();
      const r = run('month.start', d, { date: '2026-10-15' });
      expect(r.ok).toBe(true);
      expect(r.value.value.rows.map(x => [x.type, x.amount, x.from_budget])).toEqual([
        ['debt_payment', 700, 'mortgage:2026-10'], ['expense', 300, 'mortgage:2026-10:interest'],
      ]);
      expect(run('month.start', apply(d, r), { date: '2026-10-15' }).value.value).toMatchObject({ posted: 0, adjusted: 0 });
    });

    it('counts a closing-month loan payment in that month\'s sweep (the interest leg\'s key too)', () => {
      // Due Sat 31 Oct, exact; first posted on 2 Nov. Housing holds 1000 at the
      // end of October, zero-monthly: the whole payment (principal + interest)
      // must be in the balance when the sweep runs, leaving nothing to sweep.
      const d = loanData({
        envelopes: [{ id: 'housing', name: 'Housing', rollover: 'zero-monthly' }],
        transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 1000, from_envelope_id: null, to_envelope_id: 'housing' }],
        budgetItems: [{ ...loanData().budgetItems[0], payment_day: 31 }],
      });
      const r = run('month.start', d, { date: '2026-11-02' });
      expect(r.value.value.rows.map(x => x.from_budget).sort()).toEqual(['mortgage:2026-10', 'mortgage:2026-10:interest']);
      expect(r.value.value.adjusted).toBe(0);
      expect(computeEnvelopeBalances(r.value.changes.transactions, { asOf: new Date(2026, 9, 31) }).get('housing')).toBe(0);
    });

    // Nov 1 2026 is a Sunday: the day-1, prev_work_day instalment is dated Fri
    // 30 Oct, in the month being closed, but belongs to November. Every leg
    // (principal, interest, fee) must be classed by its key's month, so the
    // fee leg does not reach October's sweep alone.
    it.each([
      ['plain', {}],
      ['with a fee', { loan_fee: 5 }],
    ])('classes all legs of a November loan payment dated in October together (%s)', (_label, extra) => {
      const d = loanData({
        envelopes: [{ id: 'housing', name: 'Housing', rollover: 'zero-monthly' }],
        transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 1000, from_envelope_id: null, to_envelope_id: 'housing' }],
        budgetItems: [{ ...loanData().budgetItems[0], payment_day: 1, schedule_day_type: 'prev_work_day', as_schedule_since: '2026-11-01', ...extra }],
      });
      const r = run('month.start', d, { date: '2026-11-02' });
      expect(r.ok).toBe(true);
      const legs = r.value.value.rows.filter(x => x.from_budget?.startsWith('mortgage:'));
      expect(legs.map(x => x.date)).toEqual(legs.map(() => '2026-10-30'));
      expect(legs.map(x => occurrenceMonthOf(x))).toEqual(legs.map(() => '2026-11'));
      expect(legs.map(x => x.from_budget).sort()).toEqual(
        extra.loan_fee ? ['mortgage:2026-11', 'mortgage:2026-11:fee', 'mortgage:2026-11:interest'] : ['mortgage:2026-11', 'mortgage:2026-11:interest']);
      // October's 1000 is swept whole: none of November's legs is in it.
      const sweep = r.value.value.rows.find(x => x.type === 'adjustment');
      expect(sweep).toMatchObject({ amount: -1000, date: '2026-10-31', from_budget: 'rollover:housing:2026-10' });
    });

    it('posts a plan-linked (dynamic) template fill with a tpl: key', () => {
      const d = loanData({
        budgetItems: [{ id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'env', account_id: 'chk', as_schedule: false, monthly_schedule: ALL_MONTHS, default_amount: -120, payment_day: 5, include: true }],
        envelopes: [{ id: 'env', name: 'Rent' }],
        envelopeTemplates: [template({ kind: 'dynamic', lines: undefined, assignments: [{ envelope_id: 'env', percent: 100 }] })],
      });
      const r = run('month.start', d, { date: '2026-10-15' });
      expect(r.value.value.rows).toHaveLength(1);
      expect(r.value.value.rows[0]).toMatchObject({ type: 'fill', from_budget: 'tpl:tpl:2026-10', lines: [{ envelope_id: 'env', mode: 'add', amount: 120 }] });
    });
  });

  // Parity with what the app did before 1c: the old runDueScheduled composition,
  // copied here, against month.start, on a bundle with no closing-month edge
  // cases (every occurrence is dated in the reference month, so the order the
  // two compose in cannot matter).
  describe('parity with the pre-1c scheduler composition', () => {
    const REF = new Date(2026, 9, 15, 12);
    const item = (over) => ({
      as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS, schedule_day_type: 'exact', include: true,
      account_id: 'chk', ...over,
    });
    const bundle = () => data({
      meta: { country: 'FI', scheduledTombstones: ['phone:2026-10'] },
      accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 5000 }, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000 }],
      envelopes: [
        { id: 'rent', name: 'Rent' }, { id: 'gym', name: 'Gym' }, { id: 'phone', name: 'Phone' }, { id: 'buf', name: 'Buffer' },
        { id: 'housing', name: 'Housing' },
        { id: 'groc', name: 'Groceries', rollover: 'zero-monthly' },
        { id: 'fun', name: 'Fun', rollover: 'cover-from-unallocated' },
      ],
      budgetItems: [
        item({ id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', default_amount: -100, payment_day: 5 }),
        item({ id: 'salary', kind: 'income', description: 'Salary', envelope_id: null, default_amount: 3000, payment_day: 1 }),
        item({ id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'housing', to_account_id: 'mtg', loan_rate: 3, default_amount: -1000, payment_day: 7 }),
        item({ id: 'gym', kind: 'expense', description: 'Gym', envelope_id: 'gym', default_amount: -30, payment_day: 3 }),
        item({ id: 'phone', kind: 'expense', description: 'Phone', envelope_id: 'phone', default_amount: -20, payment_day: 4 }),
      ],
      envelopeTemplates: [
        // Plan-linked fill (follows the plan items above) ...
        template({ id: 'plan', name: 'Plan', kind: 'dynamic', lines: undefined, assignments: [{ envelope_id: 'rent', percent: 100 }], schedule: { enabled: true, payment_day: 2, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS } }),
        // ... and a self-scheduled template drawn from a source envelope.
        template({ id: 'src', name: 'Top-up', lines: [{ envelope_id: 'fun', mode: 'add', amount: 40 }], schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf' } }),
      ],
      transactions: [
        // September: a surplus to sweep, a deficit to cover.
        { id: 's1', type: 'envelope_transfer', date: '2026-09-10', status: 'posted', amount: 50, from_envelope_id: null, to_envelope_id: 'groc' },
        { id: 's2', type: 'expense', date: '2026-09-20', status: 'posted', amount: 20, envelope_id: 'fun', account: 'chk', payee: 'Cinema' },
        // The gym was paid by hand, early.
        { id: 'h1', type: 'expense', date: '2026-10-03', status: 'posted', amount: 30, envelope_id: 'gym', account: 'chk', payee: 'Gym' },
      ],
    });

    // The composition js/app.js's runDueScheduled had before PR 1c (post-due
    // first, then the rollover over everything posted), with sequential ids.
    function oldComposition(d) {
      let n = 0; const idGen = () => `old${++n}`;
      const tombstones = d.meta.scheduledTombstones;
      const settledByHand = findUnlinkedScheduledPayments({
        budgetItems: d.budgetItems, envelopes: d.envelopes, transactions: d.transactions, today: REF, tombstones, country: 'FI', accounts: d.accounts,
      }).map(x => x.key);
      const { newTxs } = materializeDueBudgetItems(d.budgetItems, d.accounts, d.envelopes, d.transactions, REF, idGen, d.envelopeTemplates, 'FI', [...tombstones, ...settledByHand]);
      const { newTxs: templateTxs } = materializeDueTemplateFills(d.envelopeTemplates, d.budgetItems, d.envelopes, [...d.transactions, ...newTxs], REF, idGen, 'FI', tombstones);
      const { newTxs: rolloverTxs } = applyEnvelopeRollovers(d.envelopes, [...d.transactions, ...newTxs, ...templateTxs], REF, idGen, tombstones);
      return [...newTxs, ...templateTxs, ...rolloverTxs];
    }
    const strip = (rows) => rows.map(({ id: _id, ...rest }) => rest).sort((a, b) => a.from_budget.localeCompare(b.from_budget));

    it('month.start produces the same rows as the old composition (apart from ids)', () => {
      const d = bundle();
      const old = oldComposition(d);
      const r = run('month.start', d, { date: '2026-10-15' });
      expect(r.ok).toBe(true);
      const keys = r.value.value.rows.map(x => x.from_budget).sort();
      // The fixture really exercises every path.
      expect(keys).toEqual([
        'mortgage:2026-10', 'mortgage:2026-10:interest', 'rent:2026-10', 'salary:2026-10',
        'rollover:fun:2026-09', 'rollover:groc:2026-09', 'tpl:plan:2026-10', 'tpl:src:2026-10',
      ].sort());
      expect(keys).not.toContain('gym:2026-10');
      expect(keys).not.toContain('phone:2026-10');
      expect(strip(r.value.value.rows)).toEqual(strip(old));
      expect(r.value.value.rows.find(x => x.from_budget === 'tpl:src:2026-10').source_envelope_id).toBe('buf');
    });
  });
});

describe('month.start catch-up and working-day boundaries', () => {
  const transfer = (id, date, amount) => ({ id, date, amount, type: 'envelope_transfer', from_envelope_id: null, to_envelope_id: 'env', status: 'posted' });
  const bill = (id, date, amount) => ({ id, date, amount, type: 'expense', envelope_id: 'env', account: 'chk', status: 'posted' });
  const balance = d => computeEnvelopeBalances(d.transactions).get('env');

  it('closes every missed month chronologically, rather than netting their balances', () => {
    const d = data({
      meta: { schemaVersion: 8, last_rollover_month: '2026-07' },
      envelopes: [{ id: 'env', rollover: 'zero-monthly' }],
      transactions: [transfer('fund', '2026-08-01', 100), bill('aug', '2026-08-10', 20), bill('sep', '2026-09-10', 30)],
    });
    const r = run('month.start', d);
    expect(r.ok).toBe(true);
    expect(r.value.value.rows.map(x => [x.from_budget, x.amount])).toEqual([['rollover:env:2026-08', -80]]);
    const after = apply(d, r);
    expect(balance(after)).toBe(-30);
    expect(after.meta.last_rollover_month).toBe('2026-09');
    expect(run('month.start', after).value.changes).toEqual({});
  });

  it('covers an earlier deficit before a later month replenishes it, including across a year', () => {
    const d = data({
      meta: { last_rollover_month: '2025-11' },
      envelopes: [{ id: 'env', rollover: 'cover-from-unallocated' }],
      transactions: [bill('dec', '2025-12-20', 20), transfer('jan', '2026-01-10', 10)],
    });
    const r = run('month.start', d, { date: '2026-02-02' });
    expect(r.value.value.rows[0]).toMatchObject({ from_budget: 'rollover:env:2025-12', date: '2025-12-31', amount: 20 });
    expect(balance(apply(d, r))).toBe(10);
    expect(r.value.changes.meta.last_rollover_month).toBe('2026-01');
  });

  it('records progress when no adjustment is needed, and never moves it backwards', () => {
    const first = run('month.start', data());
    expect(first.value.changes).toEqual({ meta: { last_rollover_month: '2026-09' } });
    const after = apply(data(), first);
    expect(run('month.start', after).value.changes).toEqual({});
    expect(run('month.start', after, { date: '2026-09-01' }).value.changes).toEqual({});
  });

  it('uses the legacy setup month as a bound and respects deleted rollover markers', () => {
    const d = data({
      meta: { last_opened_month: '2026-08', scheduledTombstones: ['rollover:env:2026-08'] },
      envelopes: [{ id: 'env', rollover: 'zero-monthly' }],
      transactions: [transfer('fund', '2026-08-01', 100), bill('sep', '2026-09-10', 30)],
    });
    const r = run('month.start', d);
    expect(r.value.value.rows.map(x => x.from_budget)).toEqual(['rollover:env:2026-09']);
    expect(r.value.value.rows[0].amount).toBe(-70);
  });

  it.each(['zero-monthly', 'cover-from-unallocated'])('waits for a next-working-day bill before closing its month (%s)', policy => {
    const d = data({
      meta: { last_rollover_month: '2026-09' },
      envelopes: [{ id: 'env', rollover: policy }],
      transactions: [transfer('fund', '2026-10-10', policy === 'zero-monthly' ? 100 : 10)],
      budgetItems: [rentItem({ payment_day: 31, schedule_day_type: 'next_work_day', default_amount: -30, end_month: '2026-10' })],
    });
    const first = run('month.start', d, { date: '2026-11-01' });
    expect(first.value.value.adjusted).toBe(0);
    expect(first.value.changes.meta).toBeUndefined();
    const second = run('month.start', apply(d, first), { date: '2026-11-02' });
    expect(second.value.value.rows.find(x => x.type === 'expense')).toMatchObject({ date: '2026-11-02', from_budget: 'rent:2026-10' });
    expect(second.value.value.rows.find(x => x.type === 'adjustment')).toMatchObject({ date: '2026-10-31', amount: policy === 'zero-monthly' ? -70 : 20 });
    expect(balance(apply(apply(d, first), second))).toBe(0);
    const oneOpen = run('month.start', d, { date: '2026-11-02' });
    expect(balance(apply(d, oneOpen))).toBe(0);
    expect(run('month.start', apply(d, oneOpen), { date: '2026-11-03' }).value.changes).toEqual({});
  });

  it('resolves a sourced set fill against the balance after the preceding sweep', () => {
    const d = data({
      meta: { last_rollover_month: '2026-08' },
      envelopes: [{ id: 'env', rollover: 'zero-monthly' }, { id: 'buffer' }],
      transactions: [transfer('fund', '2026-09-01', 40), { ...transfer('buffer', '2026-09-01', 1000), to_envelope_id: 'buffer' }],
      envelopeTemplates: [template({ lines: [{ envelope_id: 'env', mode: 'set', amount: 100 }], schedule: { ...template().schedule, source_envelope_id: 'buffer' } })],
    });
    const r = run('month.start', d);
    const fill = r.value.value.rows.find(x => x.type === 'fill');
    expect(fill.lines).toContainEqual({ envelope_id: 'buffer', mode: 'add', amount: -100 });
    expect(balance(apply(d, r))).toBe(100);
    expect(computeEnvelopeBalances(r.value.changes.transactions).get('buffer')).toBe(900);
  });
});


it('bootstraps catch-up after a legacy rollover without changing the history behind it', () => {
  const d = data({
    meta: { last_opened_month: '2026-07' },
    envelopes: [{ id: 'env', rollover: 'zero-monthly' }],
    transactions: [
      { id: 'f', date: '2026-08-01', type: 'fill', lines: [{ envelope_id: 'env', amount: 100 }] },
      { id: 'b', date: '2026-09-05', type: 'expense', amount: 30, envelope_id: 'env', account: 'chk' },
      { id: 'r', date: '2026-09-30', type: 'adjustment', target: 'envelope', target_id: 'env', amount: -70, from_budget: 'rollover:env:2026-09' },
    ],
  });
  const r = run('month.start', d);
  expect(r.value.value.rows).toEqual([]);
  expect(r.value.changes).toEqual({ meta: { ...d.meta, last_rollover_month: '2026-09' } });
});
