// account.archive — archive or unarchive an account. Only `archived` changes.
// Asking for the state it is already in is refused, so every success has a
// diff for Undo to reverse.

import { ok, fail } from '../result.js';

export default {
  name: 'account.archive',
  summary: 'Archive (archived: true) or unarchive (archived: false) an account. Refused when it is already in that state.',
  input: {
    type: 'object',
    required: ['id', 'archived'],
    properties: {
      id: { type: 'ref', kind: 'account' },
      archived: { type: 'boolean' },
    },
  },
  execute(data, input) {
    const { id, archived } = input;
    const acc = data.accounts.find(a => a.id === id);
    if (Boolean(acc.archived) === archived) {
      return fail('bad_input', { errors: [{ path: 'archived', message: archived ? 'the account is already archived' : 'the account is not archived' }] });
    }
    const scenarioExpenses = (Array.isArray(data.meta?.stressExpenses) ? data.meta.stressExpenses : []).filter(e => e?.account === id).length;
    if (archived && scenarioExpenses) return fail('in_use', { kind: 'account', id, refs: { scenarioExpenses } });
    const accounts = data.accounts.map(a => (a.id === id ? { ...a, archived } : a));
    return ok({ changes: { accounts }, value: { id, archived } });
  },
};
