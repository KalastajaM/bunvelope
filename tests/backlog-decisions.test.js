import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { splitByCleared } from '../js/reconcile-model.js';
import { reconciledLedgerBalance } from '../js/engine/reconciled.js';
import { stressExpenses, stressExpenseRows, stressExpenseAnnual } from '../js/engine/stress-expenses.js';
import { simulate } from '../js/engine/simulation.js';
import { MONTHS } from '../js/engine/stress.js';

const ctx = () => makeCtx({ now: new Date(2026, 8, 15, 12), newId: () => 'extra-1' });
const data = () => ({ accounts: [{ id: 'bank', type: 'bank', name: 'Bank', initialBalance: 1000 }], envelopes: [], budgetItems: [], transactions: [], envelopeTemplates: [], meta: {} });
const cmd = (d, name, input) => { const r = runCommand(registry, d, name, input, ctx()); return r.ok ? { ok: true, ...r.value } : r; };
const ask = (d, name, input = {}) => runQuery(registry, d, name, input, ctx());
const extra = () => ({ id: 'medical', name: 'Medical costs', account: 'bank', day: 20, amounts: { A: 100, B: 50 }, months: Object.fromEntries(MONTHS.map(m => [m, true])) });

describe('approved backlog decisions', () => {
  it('excludes undated rows from both reconciliation totals and blocks the command until repaired', () => {
    const d = data();
    d.transactions = [{ id: 'no-date', type: 'expense', account: 'bank', amount: 50, cleared: true }];
    const a = { ...d.accounts[0], lastReconciledAt: '2026-09-15' };
    expect(splitByCleared(a, d.transactions, a.id, a.lastReconciledAt)).toMatchObject({ clearedBaseline: 1000, uncleared: [], undated: [d.transactions[0]] });
    expect(reconciledLedgerBalance(a, d.transactions)).toBe(1000);
    for (const more of [{}, { clear: [] }, { force: true }]) expect(cmd(d, 'account.reconcile', { account: 'bank', balance: 950, ...more })).toMatchObject({ ok: false, error: { code: 'reconcile_undated' } });
    d.transactions = d.transactions.map(t => ({ ...t, date: '2026-09-10' }));
    expect(cmd(d, 'account.reconcile', { account: 'bank', balance: 950, clear: [] })).toMatchObject({ ok: true, value: { diff: 0, adjusted: false } });
  });

  it('keeps annual-average fields while adding the selected calendar month', () => {
    const d = data(); d.envelopes = [{ id: 'bills', name: 'Bills' }];
    d.budgetItems = [{ id: 'annual', envelope_id: 'bills', default_amount: 1200, monthly_schedule: { Sep: true } }];
    expect(ask(d, 'spending.month').value).toMatchObject({ planned: 100, averageMonthlyFunding: 100, calendarPlanned: 1200 });
    expect(ask(d, 'spending.month', { month: '2026-10' }).value).toMatchObject({ planned: 100, calendarPlanned: 0 });
  });

  it('does not count archived spending accounts in the cash trend or headline', () => {
    const d = data(); d.accounts.push({ id: 'old', type: 'bank', archived: true, initialBalance: 900 });
    const r = ask(d, 'cash.position', { months: 2 }).value;
    expect(r).toMatchObject({ balance: 1000, accountCount: 1 });
    expect(r.series.map(p => p.balance)).toEqual([1000, 1000]);
  });

  it('allows holding metadata but refuses ignored numerical corrections, including manual-row holdings', () => {
    const d = data(); d.accounts.push({ id: 'broker', type: 'investment' });
    d.meta.investments = { manualRows: { broker: { ABC: [{ id: 'buy', direction: 'buy', date: '2026-09-01', units: 10, amount: 100 }] } } };
    expect(cmd(d, 'investment.setHolding', { account: 'broker', symbol: 'ABC', units: 12, costBasis: 100 })).toMatchObject({ ok: false, error: { code: 'holding_has_history' } });
    expect(cmd(d, 'investment.setHolding', { account: 'broker', symbol: 'ABC', units: 10, costBasis: 100, name: 'Updated label' }).ok).toBe(true);
  });
});

describe('scenario-only expenses', () => {
  it('creates, edits and deletes metadata without writing ledger rows or plan items', () => {
    const d = data(); const { id, ...input } = extra();
    const r = cmd(d, 'stressExpense.set', input); expect(r.ok).toBe(true);
    expect(Object.keys(r.changes)).toEqual(['meta']); expect(d.meta).toEqual({});
    const next = { ...d, ...r.changes };
    const updated = cmd(next, 'stressExpense.set', { ...input, id: r.value.id, amounts: { A: 200 } });
    expect(updated.value.amounts).toEqual({ A: 200 });
    expect(cmd({ ...next, ...updated.changes }, 'stressExpense.delete', { id: r.value.id }).changes.meta.stressExpenses).toEqual([]);
    expect(cmd(d, 'stressExpense.delete', { id }).changes).toEqual({});
    expect(cmd(next, 'account.archive', { id: 'bank', archived: true })).toMatchObject({ ok: false, error: { code: 'in_use' } });
    expect(cmd(next, 'account.update', { id: 'bank', fields: { spending: false } })).toMatchObject({ ok: false, error: { code: 'in_use' } });
    expect(cmd(next, 'account.delete', { id: 'bank' })).toMatchObject({ ok: false, error: { code: 'in_use' } });
  });

  it('refuses invalid costs, empty schedules, missing ids and non-spending accounts', () => {
    const d = data(); const { id, ...input } = extra();
    for (const patch of [{ amounts: { A: -1 } }, { amounts: {} }, { months: {} }, { name: ' ' }, { day: 31 }, { id }, { account: 'missing' }]) {
      expect(cmd(d, 'stressExpense.set', { ...input, ...patch }).ok).toBe(false);
    }
    d.accounts[0].archived = true;
    expect(cmd(d, 'stressExpense.set', input).ok).toBe(false);
  });

  it('adds calendar-weighted costs only to the specified stress scenarios', () => {
    const d = data(); const e = extra(); e.months = { Sep: true, Dec: true }; d.meta.stressExpenses = [e];
    const r = ask(d, 'stress.runway').value;
    expect(r.scenarios.find(s => s.scenario === 'Baseline').expense).toBe(0);
    expect(r.scenarios.find(s => s.scenario === 'A')).toMatchObject({ expense: 200, extraExpense: 200, delta: -200 });
    expect(r.scenarios.find(s => s.scenario === 'B').expense).toBe(100);
    expect(r.scenarios.find(s => s.scenario === 'E').expense).toBe(0);
    expect(r.extraExpenses[0].annual.A).toBe(200);
    expect(r.scenarios.find(s => s.scenario === 'A').months).toBeCloseTo(60);
    expect(stressExpenseAnnual(e, 'Baseline')).toBe(0);
  });

  it('handles the date window and severity changes without duplicating expenses', () => {
    const e = extra(); e.months.Oct = false;
    const scenario = { id: 'crisis', changes: [{ type: 'stress', scenario: 'A', from: '2026-09' }, { type: 'stress', scenario: 'B', from: '2026-11' }] };
    expect(stressExpenseRows([e], scenario, '2026-09-21', '2026-12-19')).toMatchObject([{ date: '2026-11-20', amount: 50, is_forecast: true }]);
    expect(stressExpenseRows([e], null, '2026-09-01', '2027-01-01')).toEqual([]);
    expect(stressExpenses([null, {}, { ...e, amounts: { A: -5 } }, e, e])).toEqual([e]);
    expect(stressExpenses(null)).toEqual([]);
  });

  it('changes a stress simulation, never the baseline or stored ledger', () => {
    const d = data(); d.meta.stressExpenses = [extra()];
    const today = new Date(2026, 8, 15, 12);
    const base = simulate({ source: d, today, months: 1 });
    const scenario = { id: 'crisis', name: 'Crisis', changes: [{ type: 'stress', scenario: 'A', from: '2026-09' }] };
    const stressed = simulate({ source: d, today, months: 1, scenario });
    expect(base.monthly.at(-1).accounts.get('bank')).toBe(1000);
    expect(stressed.monthly.at(-1).accounts.get('bank')).toBe(800);
    expect(d.transactions).toEqual([]); expect(d.budgetItems).toEqual([]);
  });
});
