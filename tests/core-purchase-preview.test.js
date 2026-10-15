import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery, runBatch } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { projectEnvelopeBalance, envelopeFloor } from '../js/engine/envelope-forecast.js';

const newId = vi.fn(() => 'real-id');
const ctx = makeCtx({ now: new Date(2026, 9, 7, 12), newId });
const every = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const fill = (id, amount) => ({ id: 'fill:' + id, type: 'fill', date: '2026-10-01', status: 'posted', lines: [{ envelope_id: id, mode: 'add', amount }] });
const budget = () => ({ meta: { schemaVersion: 1, country: 'FI' },
  accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }],
  transactions: [fill('food', 500), fill('fun', 300)], budgetItems: [], envelopeTemplates: [],
});
const input = (extra = {}) => ({ amount: 100, date: '2026-10-07', account: 'bank', envelope: 'food', payee: 'Shop', ...extra });
const query = (d, i = input(), c = ctx) => runQuery(registry, d, 'purchase.preview', i, c);
const preview = (d, i = input(), c = ctx) => { const r = query(d, i, c); expect(r.ok, JSON.stringify(r)).toBe(true); return r.value; };

describe('purchase preview', () => {
  it('is read-only, consumes no real ids, and shows known spare and cash changes', () => {
    const d = budget(); const original = structuredClone(d); newId.mockClear();
    const r = preview(d);
    expect(d).toEqual(original); expect(newId).not.toHaveBeenCalled();
    expect(r.status).toBe('covered');
    expect(r.envelope.before.spare).toBe(500); expect(r.envelope.after.spare).toBe(400);
    expect(r.accounts[0]).toMatchObject({ before: { low: { balance: 1000 } }, after: { low: { balance: 900 }, firstNegative: null } });
  });
  it('explains a negative forecast separately from a positive current balance and unknown card repayment', () => {
    const d = budget();
    d.accounts.push({ id: 'card', name: 'Mastercard', type: 'credit_card' });
    d.transactions.push({ id: 'future', type: 'expense', account: 'bank', amount: 12724.88, date: '2027-09-30', status: 'scheduled' });
    const r = preview(d, input({ account: 'card', date: '2026-12-31', amount: 500 }));
    expect(r).toMatchObject({ assessment: 'incomplete', repaymentUnknown: true, status: 'attention' });
    expect(r.accounts[0]).toMatchObject({ current: 1000, changeToLow: -12724.88, lowDifference: 0,
      movements: { spending: -12724.88, income: 0 }, impact: 'existing',
      before: { low: { balance: -11724.88, date: '2027-09-30' } },
      after: { low: { balance: -11724.88, date: '2027-09-30' } } });
  });
  it('reconciles forecast movements to the low from posted balances, including today’s purchase and pending rows', () => {
    const d = budget();
    d.transactions.push(
      { id: 'posted', type: 'expense', account: 'bank', amount: 20, date: '2026-10-06', status: 'posted' },
      { id: 'pending', type: 'expense', account: 'bank', amount: 50, date: '2026-10-07', status: 'scheduled' },
      { id: 'income', type: 'income', account: 'bank', amount: 10, date: '2026-10-07', status: 'scheduled' },
      { id: 'transfer', type: 'account_transfer', from_account: 'bank', to_account: 'elsewhere', amount: 25, date: '2026-10-07', status: 'scheduled' });
    const a = preview(d).accounts[0];
    expect(a).toMatchObject({ current: 980, changeToLow: -165, movements: { spending: -150, income: 10, transfers: -25 } });
    expect(a.current + Object.values(a.movements).reduce((sum, v) => sum + v, 0)).toBe(a.after.low.balance);
  });
  it('detects a temporary cash shortfall before a later income even when the month ends positive', () => {
    const d = budget(); d.accounts[0].initialBalance = 50;
    d.transactions.push({ id: 'salary', type: 'income', account: 'bank', amount: 1000, date: '2026-10-25', status: 'scheduled' });
    const r = preview(d, input({ date: '2026-10-10' }));
    expect(r.status).toBe('attention');
    expect(r.accounts[0]).toMatchObject({ impact: 'new', after: { firstNegative: { date: '2026-10-10', balance: -50 }, low: { balance: -50 } } });
  });
  it('distinguishes existing and worsened deficits instead of blaming all of them on the purchase', () => {
    const d = budget(); d.accounts.push({ id: 'other', name: 'Other', type: 'bank', initialBalance: -20 });
    d.accounts[0].initialBalance = -50;
    const r = preview(d);
    expect(r.accounts.find(a => a.id === 'bank').impact).toBe('worse');
    expect(r.accounts.find(a => a.id === 'other').impact).toBe('existing');
    d.accounts[0].initialBalance = 1000;
    expect(preview(d).assessment).toBe('existing');
  });
  it('includes savings accounts in cash checks', () => {
    const d = budget(); d.accounts[0].type = 'savings'; d.accounts[0].initialBalance = 50;
    expect(preview(d).accounts[0].after.firstNegative.balance).toBe(-50);
  });
  it('follows configured card settlements to the paying account and does not call card debt a cash shortfall', () => {
    const d = budget(); d.accounts[0].initialBalance = 100;
    d.accounts.push({ id: 'card', name: 'Card', type: 'credit_card', initialBalance: 0, settledFrom: 'bank' });
    const r = preview(d, input({ amount: 200, account: 'card', date: '2026-10-08' }));
    expect(r.repaymentUnknown).toBe(false);
    expect(r.accounts.some(a => a.id === 'card')).toBe(false);
    expect(r.accounts[0].after.low.balance).toBe(-100);
    expect(r.accounts[0]).toMatchObject({ current: 100, changeToLow: -200, movements: { repayments: -200 } });
    expect(r.accounts[0].after.firstNegative.date).toMatch(/^2026-11-/);
    delete d.accounts[1].settledFrom;
    expect(preview(d, input({ account: 'card' }))).toMatchObject({ status: 'incomplete', repaymentUnknown: true });
  });
  it('compares savings goals and never claims to assess dates outside the window', () => {
    const d = budget(); d.envelopes[0] = { ...d.envelopes[0], goal_amount: 450, goal_date: '2026-11-01' };
    const r = preview(d);
    expect(r.goals[0]).toMatchObject({ before: { status: 'onTrack', projected: 500 }, after: { status: 'short', projected: 400, gap: 50 } });
    d.envelopes[0].goal_date = '2028-11-01';
    expect(preview(d)).toMatchObject({ status: 'incomplete', goals: [{ after: { status: 'outside', projected: null } }] });
  });
  it('does not approve a card repayment falling after the forecast window', () => {
    const d = budget();
    d.accounts.push({ id: 'card', name: 'Card', type: 'credit_card', settledFrom: 'bank' });
    expect(preview(d, input({ account: 'card', date: '2027-10-06' }))).toMatchObject({ status: 'incomplete', repaymentUnknown: false, repaymentBeyondWindow: true });
  });
  it('previews a funding move, protects source goals in suggestions, and records exactly the previewed rows atomically', () => {
    const d = budget(); d.transactions[0] = fill('food', 50);
    d.envelopes[1] = { ...d.envelopes[1], goal_amount: 280, goal_date: '2026-11-01' };
    const plain = preview(d);
    expect(plain.suggestions).toEqual([{ id: 'fun', name: 'Fun', amount: 20 }]);
    const r = preview(d, input({ fundingEnvelope: 'fun', fundingAmount: 50 }));
    expect(r.envelope.after.spare).toBe(0);
    expect(r.funding).toMatchObject({ amount: 50, after: { spare: 250 } });
    expect(r.goals[0].after).toMatchObject({ status: 'short', gap: 30 });
    expect(r.status).toBe('attention');
    let n = 0;
    const saved = runBatch(registry, d, r.steps, makeCtx({ now: ctx.now, newId: () => `tx${++n}` }), { checks: applyCommitChecks });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(saved.value.after.transactions).toHaveLength(d.transactions.length + 2);
    const p = projectEnvelopeBalance({ ...saved.value.after, envelopeId: 'food', today: ctx.today, months: 12 });
    expect(p.low.balance - envelopeFloor(d.budgetItems, 'food')).toBe(r.envelope.after.spare);
  });
  it('keeps future rows scheduled and includes the expense exactly once', () => {
    const r = preview(budget(), input({ date: '2026-11-10', fundingEnvelope: 'fun', fundingAmount: 20 }));
    expect(r.steps.every(s => s.input.scheduled)).toBe(true);
    expect(r.envelope.after.spare).toBe(420);
    expect(r.accounts[0].after.low.balance).toBe(900);
  });
  it('warns when replenishing the purchase envelope drains a different template source below zero', () => {
    const d = budget(); d.transactions = [fill('food', 100), fill('fun', 75)];
    d.envelopeTemplates = [{ id: 'topup', name: 'Top up', lines: [{ envelope_id: 'food', mode: 'set', amount: 100 }],
      schedule: { enabled: true, payment_day: 1, months: every, since: '2026-10-01', source_envelope_id: 'fun' } }];
    const r = preview(d, input({ date: '2026-11-10' }));
    expect(r.envelope.after.spare).toBe(0);
    expect(r.status).toBe('attention');
    expect(r.otherEnvelopes).toContainEqual(expect.objectContaining({ id: 'fun', after: expect.objectContaining({ spare: -25 }) }));
  });
  it('uses existing plan netting instead of blindly subtracting the purchase from projected spare', () => {
    const d = budget();
    d.budgetItems = [{ id: 'food-plan', kind: 'expense', description: 'Food', envelope_id: 'food', account_id: 'bank', default_amount: -100, monthly_schedule: every, include: true, as_schedule: false }];
    const r = preview(d);
    const recorded = { ...d, transactions: [...d.transactions, { id: 'expense', type: 'expense', account: 'bank', envelope_id: 'food', amount: 100, date: '2026-10-07', status: 'posted' }] };
    const p = projectEnvelopeBalance({ ...recorded, envelopeId: 'food', today: ctx.today, months: 12 });
    expect(r.envelope.after.spare).toBe(p.low.balance - envelopeFloor(d.budgetItems, 'food'));
    expect(r.envelope.before.spare - r.envelope.after.spare).toBeLessThan(100);
  });
  it('rejects invalid dates, archived selections, noncash accounts and incomplete funding inputs', () => {
    const d = budget();
    for (const extra of [{ amount: 0 }, { amount: -1 }, { date: '2026-10-06' }, { date: '2027-10-07' }, { date: '2026-02-30' }, { fundingEnvelope: 'fun' }, { fundingAmount: 10 }, { fundingEnvelope: 'food', fundingAmount: 10 }]) {
      expect(query(d, input(extra)).ok, JSON.stringify(extra)).toBe(false);
    }
    d.envelopes[0].archived = true; expect(query(d).ok).toBe(false);
    d.envelopes[0].archived = false; d.accounts[0].type = 'investment'; expect(query(d).ok).toBe(false);
  });
  it('keeps the twelve-month date window stable through leap days in every timezone', () => {
    const c = makeCtx({ now: new Date(2028, 1, 29, 12), newId });
    const d = budget();
    const r = preview(d, input({ date: '2029-02-27' }), c);
    expect(r.end).toBe('2029-02-27');
    expect(query(d, input({ date: '2029-02-28' }), c).ok).toBe(false);
  });
});
