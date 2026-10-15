import { ok } from '../result.js';
import { compactFinancialHistory } from '../financial-history.js';
import { deepEqual } from '../diff.js';
export default {
  name: 'history.compact',
  summary: 'Consolidate verified redundant history snapshots without deleting revisions or crossing unknown days.',
  input: { type: 'object', properties: {} },
  execute(data) {
    const history = compactFinancialHistory(data.meta?.financialHistory);
    const changed = !deepEqual(history, data.meta?.financialHistory);
    return ok({ changes: changed ? { meta: { ...data.meta, financialHistory: history } } : {}, value: { compacted: changed } });
  },
};
