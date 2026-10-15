import { describe, it, expect } from 'vitest';
import { spendingProfiles, projectPlannedSpending } from '../../js/engine/spending-profile.js';
import { lensTransactions } from '../../js/engine/lens.js';
import { txAbsAmount } from '../../js/engine/tx-amounts.js';
import { computeAccountBalances } from '../../js/engine/balances.js';
import { projectEnvelopeBalance } from '../../js/engine/envelope-forecast.js';
import { registry } from '../../js/core/index.js';
import { runCommand, runQuery } from '../../js/core/pipeline.js';
import { makeCtx } from '../../js/core/context.js';
const today = new Date(2026, 9, 7, 12);
const ctx = makeCtx({ now: today, newId: () => 'new' });
const accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 500 }, { id: 'card', name: 'Card', type: 'credit_card', initialBalance: 0 }];
const envelopes = [{ id: 'food', name: 'Food' }];
const expense = (date, account, amount, extra = {}) => ({ id: `${date}:${account}:${amount}`, type: 'expense', date, account, amount, envelope_id: 'food', ...extra });
const base = () => ({ meta: {}, accounts, envelopes, transactions: [expense('2026-09-01', 'card', 800), expense('2026-09-02', 'bank', 200)],
  budgetItems: [{ id: 'food-plan', kind: 'expense', envelope_id: 'food', include: true, funding_style: 'spending', default_amount: -600, monthly_schedule: { Nov: true } }], envelopeTemplates: [] });
const shares = d => spendingProfiles(d, today).byEnvelope.get('food');
const generated = (d, end = '2026-11-30') => lensTransactions(d, { lens: 'forecast', horizon: end, today }).filter(r => r.is_planned);
const total = rows => Math.round(rows.reduce((sum, r) => sum + txAbsAmount(r), 0) * 100) / 100;

describe('Historical spending profiles', () => {
  it('uses amounts and recency, excludes future, old, unposted, archived and transfer rows, and respects envelope splits', () => {
    const d = base();
    d.accounts = [...accounts, { id: 'old', type: 'bank', archived: true }];
    d.transactions = [expense('2026-05-01', 'card', 300), expense('2026-10-01', 'bank', 100),
      expense('2026-04-30', 'bank', 10000), expense('2026-10-08', 'bank', 10000),
      expense('2026-09-01', 'old', 10000), expense('2026-09-01', 'bank', 10000, { status: 'scheduled' }),
      expense('2026-09-01', 'bank', 10000, { is_forecast: true }),
      expense('2026-09-01', 'bank', 10000, { type: 'account_transfer' })];
    expect(shares(d).shares.map(s => s.percent)).toEqual([66.67, 33.33]);
    d.transactions = [expense('2026-09-01', 'card', 100, { envelope_splits: [{ envelope_id: 'food', amount: 20 }, { envelope_id: 'other', amount: 80 }] }), expense('2026-09-01', 'bank', 20)];
    expect(shares(d).shares.map(s => s.percent)).toEqual([50, 50]);
  });
  it('reports limited/variable/established evidence and uses household history for a new envelope', () => {
    const d = base(); expect(shares(d).confidence).toBe('limited');
    d.transactions = ['07', '08', '09'].flatMap(m => Array.from({ length: 4 }, (_, i) => expense(`2026-${m}-0${i + 1}`, 'card', 10)));
    expect(shares(d).confidence).toBe('established');
    d.transactions[0] = expense('2026-07-01', 'bank', 10000);
    expect(shares(d).confidence).toBe('variable');
    d.envelopes = [...envelopes, { id: 'new', name: 'New' }];
    expect(spendingProfiles(d, today).byEnvelope.get('new')).toMatchObject({ source: 'household', confidence: 'limited', sampleCount: 0 });
  });
  it('conserves cents across accounts and days, and gives identical amounts at short and long horizons', () => {
    const d = base(); d.budgetItems[0].default_amount = -600.01;
    const rows = generated(d);
    expect(total(rows)).toBe(600.01);
    expect(total(rows.filter(r => r.account === 'bank'))).toBe(120);
    expect(total(rows.filter(r => r.account === 'card'))).toBe(480.01);
    expect(generated(d, '2026-11-15')).toEqual(rows.filter(r => r.date <= '2026-11-15'));
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(rows.every(r => r.forecast_estimate.timing === 'daily')).toBe(true);
  });
  it('nets recorded spending once before splitting, and honours tombstones before expansion', () => {
    const d = base(); d.transactions.push(expense('2026-11-05', 'card', 150));
    expect(total(generated(d))).toBe(450);
    d.meta.scheduledTombstones = ['food-plan:2026-11'];
    expect(generated(d)).toEqual([]);
  });
  it('keeps explicit dates/accounts and bills intact, while overrides replace only inferred accounts', () => {
    const d = base(); d.envelopes = [{ ...envelopes[0], forecast_account_shares: [{ account_id: 'bank', percent: 100 }] }];
    expect(generated(d).every(r => r.account === 'bank')).toBe(true);
    d.budgetItems = [{ ...d.budgetItems[0], account_id: 'card', payment_day: 12 }];
    const rows = generated(d); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ account: 'card', date: '2026-11-12', amount: 600 });
    d.budgetItems = [{ ...d.budgetItems[0], payment_day: 0, funding_style: 'bill' }];
    expect(generated(d)[0]).toMatchObject({ date: '2026-11-30', amount: 600 });
  });
  it('feeds daily spending into target top-ups without changing net worth', () => {
    const d = base(); d.accounts = [...accounts, { id: 'income', type: 'bank', initialBalance: 10000 }];
    d.budgetItems.push(...[1, 15].map(day => ({ id: `top${day}`, kind: 'account_transfer', transfer_mode: 'target_balance', target_balance: 500,
      account_id: 'income', to_account_id: 'bank', as_schedule: true, include: true, payment_day: day, monthly_schedule: { Nov: true } })));
    const rows = lensTransactions(d, { lens: 'forecast', horizon: '2026-11-30', today });
    expect(rows.find(r => r.forecast_budget_item_id === 'top15')).toMatchObject({ amount: 56 });
    const withTransfers = computeAccountBalances(d.accounts, rows);
    const without = computeAccountBalances(d.accounts, rows.filter(r => r.type !== 'account_transfer'));
    expect([...withTransfers.values()].reduce((a, b) => a + b, 0)).toBe([...without.values()].reduce((a, b) => a + b, 0));
  });
  it('spreads only remaining current-month spending and clamps leap-month/date bounds', () => {
    const row = { id: 'p', is_planned: true, forecast_spread: true, forecast_month_key: '2028-02', date: '2028-02-29', amount: 100, account: 'bank', forecast_spread_until: '2028-02-27' };
    const rows = projectPlannedSpending([row], { today: new Date(2028, 1, 24, 12), end: '2028-02-29' });
    expect(rows.map(r => r.date)).toEqual(['2028-02-25', '2028-02-26', '2028-02-27']); expect(total(rows)).toBe(100);
  });
  it('shares timing with the envelope projection', () => {
    const d = base();
    const p = projectEnvelopeBalance({ ...d, envelopeId: 'food', today, months: 2 });
    const first = p.daily.find(r => r.date === '2026-11-01');
    const middle = p.daily.find(r => r.date === '2026-11-15');
    expect(first.balance - middle.balance).toBe(280);
  });
});

it('validates override writes and exposes the same profile through core', () => {
  const d = base();
  for (const shares of [[], [{ account_id: 'bank', percent: 90 }], [{ account_id: 'bank', percent: 50 }, { account_id: 'bank', percent: 50 }]]) {
    expect(runCommand(registry, d, 'envelope.update', { id: 'food', fields: { forecast_account_shares: shares } }, ctx).ok).toBe(false);
  }
  const result = runCommand(registry, d, 'envelope.update', { id: 'food', fields: { forecast_account_shares: [{ account_id: 'bank', percent: 25 }, { account_id: 'card', percent: 75 }] } }, ctx);
  expect(result.ok).toBe(true);
  const updated = { ...d, ...result.value.changes };
  expect(runQuery(registry, updated, 'spending.profile', { id: 'food' }, ctx).value).toMatchObject({ source: 'override', shares: [{ percent: 25 }, { percent: 75 }] });
  expect(runCommand(registry, updated, 'envelope.update', { id: 'food', fields: { forecast_account_shares: null } }, ctx).value.changes.envelopes[0]).not.toHaveProperty('forecast_account_shares');
});


it('labels inferred cash shortfalls and protects accounts used by manual profiles', () => {
  const d = base(); d.accounts = [{ ...accounts[0], initialBalance: 200 }, accounts[1]];
  const answer = runQuery(registry, d, 'overview.attention', {}, ctx);
  expect(answer.ok).toBe(true);
  expect(answer.value.items.find(i => i.id === 'bank' && i.kind === 'account').estimated).toBe(true);
  const manual = { ...d, transactions: [], envelopes: [{ ...envelopes[0], forecast_account_shares: [{ account_id: 'bank', percent: 100 }] }] };
  const deleted = runCommand(registry, manual, 'account.delete', { id: 'bank' }, ctx);
  expect(deleted).toMatchObject({ ok: false, error: { code: 'in_use', params: { refs: { spendingProfiles: 1 } } } });
});

it('preserves envelope spending when no eligible account exists', () => {
  const d = base(); d.accounts = []; d.transactions = [];
  expect(total(generated(d))).toBe(600);
});


it('preserves identical daily envelope totals before and after splitting tiny amounts', () => {
  const d = base();
  d.envelopes = [{ ...envelopes[0], forecast_account_shares: [{ account_id: 'bank', percent: 50 }, { account_id: 'card', percent: 50 }] }];
  const row = { id: 'tiny', is_planned: true, envelope_id: 'food', forecast_spread: true, forecast_month_key: '2026-11', date: '2026-11-30', amount: 0.02 };
  const plain = projectPlannedSpending([row], { today, end: '2026-11-30' });
  const split = projectPlannedSpending([row], { today, end: '2026-11-30', profiles: spendingProfiles(d, today) });
  const byDay = rows => Object.fromEntries([...new Set(rows.map(r => r.date))].map(date => [date, total(rows.filter(r => r.date === date))]));
  expect(byDay(split)).toEqual(byDay(plain));
  expect(total(split.filter(r => r.account === 'bank'))).toBe(0.01);
  expect(total(split.filter(r => r.account === 'card'))).toBe(0.01);
});
