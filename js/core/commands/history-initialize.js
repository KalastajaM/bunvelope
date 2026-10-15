import { ok } from '../result.js';
import { appendFinancialHistory } from '../financial-history.js';
import { same } from '../comparison.js';
export default {
  name: 'history.initialize', internal: true,
  summary: 'Automatically initialize financial history when a budget opens; preserve continuous existing history.',
  input: { type: 'object', properties: {} },
  execute(data, _input, ctx) {
    const history = appendFinancialHistory(data, data, ctx.now);
    return ok({ changes: same(history, data.meta?.financialHistory) ? {} : { meta: { ...data.meta, financialHistory: history } }, value: null });
  },
};
