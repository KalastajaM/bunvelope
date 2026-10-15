import { ok } from '../result.js';
export default {
  name: 'stressExpense.delete',
  summary: 'Delete a scenario-only expense; missing ids are a no-op.',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  execute(data, { id }) {
    const rows = Array.isArray(data.meta?.stressExpenses) ? data.meta.stressExpenses : [];
    if (!rows.some(e => e.id === id)) return ok({ changes: {}, value: { id } });
    return ok({ changes: { meta: { ...data.meta, stressExpenses: rows.filter(e => e.id !== id) } }, value: { id } });
  },
};
