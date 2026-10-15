// budgetItem.unskipOccurrence — bring back a skipped month of a plan item. The
// list is copied, never edited in place; an emptied list is dropped, so an
// item skipped and unskipped is as it was.

import { ok, fail } from '../result.js';
import { MONTH_KEY } from './budget-item-skip-occurrence.js';

export default {
  name: 'budgetItem.unskipOccurrence',
  summary: 'Undo a skipped occurrence of a plan item in one month (YYYY-MM). Refused when that month is not skipped.',
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
    if (!existing.includes(month)) return fail('bad_input', { errors: [{ path: 'month', message: 'that month is not skipped' }] });
    const { skipped_occurrences: _dropped, ...rest } = item;
    const left = existing.filter(m => m !== month);
    const next = left.length ? { ...rest, skipped_occurrences: left } : rest;
    return ok({ changes: { budgetItems: data.budgetItems.map(it => (it.id === id ? next : it)) }, value: { id, month } });
  },
};
