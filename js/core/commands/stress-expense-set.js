import { ok, fail } from '../result.js';
import { MONTHS, SCENARIOS } from '../../engine/stress.js';
import { isSpendingAccount } from '../../engine/balances.js';

export default {
  name: 'stressExpense.set',
  summary: 'Create or replace a scenario-only expense. Amounts are monthly costs for A–E; months selects active calendar months, day is 1–28. Used by Stress and stress what-if projections only, never normal posting. Omit id to create; provide an existing id to replace.',
  input: { type: 'object', required: ['name', 'account', 'amounts', 'months'], properties: {
    id: { type: 'string' }, name: { type: 'string' }, account: { type: 'ref', kind: 'account' },
    day: { type: 'integer', minimum: 1, maximum: 28, default: 1 },
    amounts: { type: 'object', properties: Object.fromEntries(SCENARIOS.map(s => [s, { type: 'money', minimum: 0 }])) },
    months: { type: 'object', properties: Object.fromEntries(MONTHS.map(m => [m, { type: 'boolean' }])) },
  } },
  execute(data, input, ctx) {
    const rows = Array.isArray(data.meta?.stressExpenses) ? data.meta.stressExpenses : [];
    if (input.id !== undefined && !rows.some(e => e.id === input.id)) return fail('not_found', { kind: 'stressExpense', id: input.id });
    const account = data.accounts.find(a => a.id === input.account);
    if (!account || account.archived || !isSpendingAccount(account)) return fail('bad_input', { errors: [{ path: 'account', message: 'needs an active spending account' }] });
    if (!input.name.trim() || !Object.values(input.amounts).some(n => n > 0) || !Object.values(input.months).some(Boolean)) {
      return fail('bad_input', { errors: [{ path: 'name', message: 'needs a name, a positive scenario amount and an active month' }] });
    }
    const row = { ...input, name: input.name.trim(), id: input.id ?? ctx.newId() };
    const stressExpenses = input.id === undefined ? [...rows, row] : rows.map(e => e.id === row.id ? row : e);
    return ok({ changes: { meta: { ...data.meta, stressExpenses } }, value: row });
  },
};
