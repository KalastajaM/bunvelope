import { ok } from '../result.js';

export default {
  name: 'comparison.clear',
  summary: 'Remove the saved comparison point without changing any balances.',
  input: { type: 'object', properties: {} },
  execute(data) {
    const meta = { ...data.meta };
    delete meta.comparisonPoint;
    return ok({ changes: { meta }, value: null });
  },
};
