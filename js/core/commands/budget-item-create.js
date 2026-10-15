// budgetItem.create — a new plan item. It starts from the editor's new-item
// object, takes the given fields as the editor's save stores them
// (applyItemFields, always with the kind-dependent sweep), and must pass the
// editor's checks (checkItem). The id is made as the editor makes it.

import { ok, fail } from '../result.js';
import { ITEM_FIELD_PROPERTIES, applyItemFields, checkItem, newItemId } from '../entity-fields.js';
import { MONTHS } from '../../engine/stress.js';

const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// The editor's new item (budget-plan-editor.js, openBudgetItemEditor).
const NEW_ITEM = Object.freeze({
  id: '', envelope_id: '', description: null, default_amount: 0, extra_buffer: 0, include: true,
  monthly_schedule: {}, payment_day: 0, stress_category: null, stress_cut_pct: 0,
  include_in_emergency_budget: false, as_schedule: false, account_id: null, as_schedule_since: null,
  schedule_day_type: 'exact', kind: 'expense', investment_account_id: null, symbol: null, to_account_id: null,
  start_month: null, end_month: null,
});

export default {
  name: 'budgetItem.create',
  summary: 'Create a plan item (kind defaults to expense). default_amount takes any sign and is stored positive for income and dividends, negative otherwise; it must not be zero except for transfer_mode: target_balance. A target-balance account transfer uses target_balance (0 pays off debt), topping up only; active monthly_schedule entries are on/off. monthly_schedule defaults to every month; an included item needs at least one active month. An expense may use envelope_id: null for Unallocated; a transfer, loan payment, investment and scheduled item need their accounts. Fields that do not belong to the kind are not stored. Returns { id }.',
  input: {
    type: 'object',
    properties: { ...ITEM_FIELD_PROPERTIES },
  },
  execute(data, input, ctx) {
    const fields = { ...input, kind: input.kind ?? 'expense' };
    // No schedule given = every month, as the editor's new item starts.
    const item = applyItemFields({ ...NEW_ITEM, monthly_schedule: everyMonth() }, fields, { todayIso: ctx.todayIso, prev: null });
    const bad = checkItem(item, data);
    if (bad) return fail(bad.code, bad.params);
    const id = newItemId(data.budgetItems, item);
    return ok({ changes: { budgetItems: [...data.budgetItems, { ...item, id }] }, value: { id } });
  },
};
