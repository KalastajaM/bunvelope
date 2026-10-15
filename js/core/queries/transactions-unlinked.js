import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { unlinkedPayments } from '../diagnostics.js';

export default {
  name: 'transactions.unlinked',
  summary: 'Proposed links between scheduled occurrences and recorded payments. Discovery only; no repairs are applied.',
  input: { type: 'object', properties: {
    envelope: { type: 'ref', kind: 'envelope', description: 'Limit proposals to one envelope (omits account transfers)' },
    date: { type: 'date', description: 'As-of date (YYYY-MM-DD, default query clock)' },
  } },
  run(data, input, ctx) {
    return ok({ proposals: unlinkedPayments(data, refDate(input, ctx), input.envelope) });
  },
};
