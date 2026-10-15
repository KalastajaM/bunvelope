// budgetItem.skipOccurrence — skip one month of a scheduled plan item, so the
// scheduler does not post it. The list is copied, never edited in place.

import { ok, fail } from '../result.js';

export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export default {
  name: 'budgetItem.skipOccurrence',
  summary: 'Skip a plan item\'s occurrence in one month (YYYY-MM). Refused when that month is already skipped.',
  input: {
    type: 'object',
    required: ['id', 'month'],
    properties: {
      id: { type: 'ref', kind: 'budgetItem' },
      month: { type: 'string', description: 'YYYY-MM' },
    },
  },
  execute(data, input) {
    const { id, month } = input;
    if (!MONTH_KEY.test(month)) return fail('bad_input', { errors: [{ path: 'month', message: 'must be YYYY-MM' }] });
    const item = data.budgetItems.find(it => it.id === id);
    const existing = Array.isArray(item.skipped_occurrences) ? item.skipped_occurrences : [];
    if (existing.includes(month)) return fail('bad_input', { errors: [{ path: 'month', message: 'that month is already skipped' }] });
    const next = { ...item, skipped_occurrences: [...existing, month] };
    return ok({ changes: { budgetItems: data.budgetItems.map(it => (it.id === id ? next : it)) }, value: { id, month } });
  },
};
