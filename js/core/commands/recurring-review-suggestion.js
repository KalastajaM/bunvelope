import { ok, fail } from '../result.js';
import { discoverRecurring } from '../recurring-discovery.js';
import createItem from './budget-item-create.js';
import { MONTHS } from '../../engine/stress.js';
export default {
  name: 'recurring.reviewSuggestion',
  summary: 'Dismiss, restore, link, or confirm a detected recurring expense. Create makes a future schedule atomically with its association; historical payments are unchanged. Optional amount overrides the detected estimate when creating a schedule.',
  input: { type: 'object', required: ['key', 'action'], properties: {
    key: { type: 'string' }, action: { type: 'string', enum: ['dismiss', 'restore', 'link', 'create'] },
    amount: { type: 'money', minimum: 0.01 }, itemId: { type: 'ref', kind: 'budgetItem' }, firstDate: { type: 'date' },
  } },
  execute(data, input, ctx) {
    const decisions = { ...data.meta?.recurringSuggestions };
    if (input.action === 'restore') {
      delete decisions[input.key];
      return ok({ changes: { meta: { ...data.meta, recurringSuggestions: decisions } } });
    }
    const suggestion = discoverRecurring(data, ctx.todayIso).find(s => s.key === input.key);
    if (!suggestion || suggestion.status !== 'pending') return fail('bad_input', { errors: [{ path: 'suggestion', message: 'is no longer available or the selection is invalid' }] });
    let changes = {};
    if (input.action === 'dismiss') decisions[input.key] = { dismissed: true };
    if (input.action === 'link') {
      if (!data.budgetItems.some(it => it.id === input.itemId && it.as_schedule && (it.kind || 'expense') === 'expense')) return fail('bad_input', { errors: [{ path: 'suggestion', message: 'is no longer available or the selection is invalid' }] });
      decisions[input.key] = { itemId: input.itemId };
    }
    if (input.action === 'create') {
      if (!input.firstDate || input.firstDate <= ctx.todayIso) return fail('bad_input', { errors: [{ path: 'suggestion', message: 'is no longer available or the selection is invalid' }] });
      const month = Number(input.firstDate.slice(5, 7)) - 1;
      const result = createItem.execute(data, { description: suggestion.payee, kind: 'expense', default_amount: input.amount ?? suggestion.amount,
        account_id: suggestion.accountId, envelope_id: data.envelopes.some(e => e.id === suggestion.envelopeId && !e.archived) ? suggestion.envelopeId : null,
        as_schedule: true, start_month: input.firstDate.slice(0, 7), payment_day: Number(input.firstDate.slice(8)),
        monthly_schedule: Object.fromEntries(MONTHS.map((m, i) => [m, ((i - month + 12) % suggestion.period) === 0])),
      }, ctx);
      if (!result.ok) return result;
      changes = result.value.changes;
      decisions[input.key] = { itemId: result.value.value.id };
    }
    return ok({ changes: { ...changes, meta: { ...data.meta, recurringSuggestions: decisions } } });
  },
};
