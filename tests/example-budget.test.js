import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildExampleBudget, EXAMPLE_FILES, EXAMPLE_DATE } from '../scripts/generate-example-budget.mjs';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { validate } from '../js/core/schema.js';
import { checkItem } from '../js/core/entity-fields.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { runInvariantCheck } from '../js/engine/insights.js';
import { shiftBudgetFiles } from '../js/storage/guest-adapter.js';

const data = Object.fromEntries(Object.entries(EXAMPLE_FILES).map(([k, file]) => [k, JSON.parse(readFileSync(new URL(`../budgets/example-project/${file}`, import.meta.url), 'utf8'))]));
function context(date = EXAMPLE_DATE) {
  let n = 0;
  return makeCtx({ now: new Date(`${date}T12:00:00`), newId: () => `test-${++n}` });
}
function query(name, input = {}, d = data, ctx = context()) {
  const result = runQuery(registry, d, name, input, ctx);
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.value;
}
function shifted(months) {
  const files = shiftBudgetFiles(Object.entries(EXAMPLE_FILES).map(([key, filename]) => ({ filename, data: data[key] })), months);
  return Object.fromEntries(files.map(({ filename, data }) => [Object.keys(EXAMPLE_FILES).find(k => EXAMPLE_FILES[k] === filename), data]));
}

describe('fictional shipped example', () => {
  it('is reproducible solely from public fictional constants', () => {
    expect(buildExampleBudget()).toEqual(data);
  });

  it('passes storage and accounting checks with a complete year of activity', () => {
    expect(applyCommitChecks({ transactions: [] }, data).ok).toBe(true);
    expect(runInvariantCheck(data).problems).toEqual([]);
    for (const { id, as_schedule_since, ...fields } of data.budgetItems) {
      if (as_schedule_since) expect(as_schedule_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const valid = validate(fields, registry.get('budgetItem.create').input, data);
      expect(valid.ok, `${id}: ${JSON.stringify(valid.error)}`).toBe(true);
      expect(checkItem({ id, ...fields }, data)).toBeNull();
    }
    const months = new Set(data.transactions.map(t => t.date.slice(0, 7)));
    expect(months.size).toBe(14); // opening balances, twelve complete months, current month
    expect(data.transactions.length).toBeGreaterThan(350);
    expect(new Set(data.transactions.map(t => t.type))).toEqual(new Set(['fill', 'income', 'expense', 'account_transfer', 'envelope_transfer', 'investment_transfer', 'debt_payment', 'adjustment']));
    for (const name of ['accounts', 'envelopes', 'budgetItems', 'envelopeTemplates', 'transactions']) {
      expect(new Set(data[name].map(r => r.id)).size).toBe(data[name].length);
    }
  });

  it('keeps cash, allocations, the mortgage and portfolio consistent', () => {
    const balances = query('balances', { lens: 'booked' });
    expect(balances.unallocated).toBeCloseTo(balances.totals.accounts - balances.totals.envelopes, 2);
    expect(balances.unallocated).toBeGreaterThan(0);
    expect(balances.envelopes.every(e => e.balance >= 0)).toBe(true);
    expect(balances.accounts.find(a => a.id === 'acct-credit').balance).toBeLessThan(0);
    expect(balances.accounts.find(a => a.id === 'acct-mortgage').balance).toBeGreaterThan(-169000);
    // Each payment includes principal, interest and fee, without overstating the debt reduction.
    const payments = new Map();
    for (const t of data.transactions.filter(t => t.from_budget?.startsWith('item-mortgage:'))) {
      const month = t.date.slice(0, 7);
      payments.set(month, (payments.get(month) || 0) + t.amount);
    }
    expect(payments.size).toBe(13);
    for (const total of payments.values()) expect(total).toBeCloseTo(940, 2);
    const portfolio = query('investments.holdings');
    expect(portfolio.accounts[0].gap).toBe(0);
    expect(portfolio.holdings.every(h => h.oversoldUnits === 0)).toBe(true);
    expect(portfolio.totals.value).toBe(266 * 54 + 120 * 25.5);
    expect(portfolio.holdings.find(h => h.symbol === 'DEMO-GLOBAL').realized).toBe(38);
  });

  it('offers a sustainable plan and a meaningful income-loss scenario', () => {
    const plan = query('plan.items');
    expect(plan.totals.income).toBe(4000 * 12);
    expect(plan.totals.diff).toBeGreaterThan(350 * 12); // reserve allocation is affordable
    const stress = query('stress.runway');
    expect(stress.scenarios.find(s => s.scenario === 'Baseline').runway).toBe('unlimited');
    expect(stress.scenarios.find(s => s.scenario === 'A')).toMatchObject({ income: 0, runway: 'months', netNegative: true });
    const projection = query('forecast.simulation', { months: 12 });
    expect(projection.alerts).toEqual([]);
    expect(projection.points.every(p => Number.isFinite(p.total))).toBe(true);
  });

  it('contains only demo identities and an explicit metadata allowlist', () => {
    expect(Object.keys(data.meta).sort()).toEqual(['schemaVersion', 'currency', 'country', 'name', 'emergency_envelope_id', 'emergency_duration_months', 'last_opened_month', 'last_rollover_month', 'investments'].sort());
    expect(data.meta.name).toContain('Fictional');
    expect(data.transactions.every(t => /^demo-tx-\d+$/.test(t.id))).toBe(true);
    expect(Object.keys(data.meta.investments.prices).every(s => s.startsWith('DEMO-'))).toBe(true);
    expect(data.meta.investments.holdingOverrides).toEqual({});
    expect(data.meta.investments.payeeRules).toEqual({});
    expect(data.meta.investments.manualRows).toEqual({});
  });

  it.each([-13, -1, 0, 4, 16])('does not repost history when shifted by %i months', months => {
    const d = shifted(months);
    const date = d.transactions.map(t => t.date).sort().at(-1);
    expect(runInvariantCheck(d).problems).toEqual([]);
    const first = runCommand(registry, d, 'month.start', {}, context(date), { checks: applyCommitChecks });
    expect(first.ok).toBe(true);
    expect(first.value.after.transactions).toEqual(d.transactions);
    const second = runCommand(registry, first.value.after, 'month.start', {}, context(date), { checks: applyCommitChecks });
    expect(second.value.changes).toEqual({});
    expect(query('balances', { lens: 'booked' }, d, context(date)).unallocated).toBeCloseTo(query('balances', { lens: 'booked' }).unallocated, 2);
  });
});
