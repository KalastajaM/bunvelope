// account.delete — remove an account nothing references. While transactions
// still use it, the delete is refused with the counts (archive it instead).
// A card settled from it (`settledFrom`) is not a reason to refuse: the
// setting is cleared in the same commit, and the card is no longer settled.

import { ok, fail } from '../result.js';
import { accountRefs } from '../entity-fields.js';

export default {
  name: 'account.delete',
  summary: 'Delete an account. Refused (in_use, with the counts) while any transaction still references it; archive it instead. A card settled from it (settledFrom) has that setting cleared.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'ref', kind: 'account' },
    },
  },
  execute(data, input) {
    const { id } = input;
    /** @type {Record<string, number>} */
    const refs = accountRefs(data, id);
    const scenarioExpenses = (Array.isArray(data.meta?.stressExpenses) ? data.meta.stressExpenses : []).filter(e => e?.account === id).length;
    if (scenarioExpenses) refs.scenarioExpenses = scenarioExpenses;
    const spendingProfiles = (data.envelopes || []).filter(e => e.forecast_account_shares?.some(s => s.account_id === id)).length;
    if (spendingProfiles) refs.spendingProfiles = spendingProfiles;
    if (Object.values(refs).some(n => n > 0)) return fail('in_use', { kind: 'account', id, refs });
    const accounts = data.accounts
      .filter(a => a.id !== id)
      .map(a => {
        if (a.settledFrom !== id) return a;
        const { settledFrom: _gone, ...rest } = a;
        return rest;
      });
    return ok({ changes: { accounts }, value: { id } });
  },
};
