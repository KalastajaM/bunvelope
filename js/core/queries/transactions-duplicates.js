import { ok } from '../result.js';
import { duplicateGroups } from '../diagnostics.js';

export default {
  name: 'transactions.duplicates',
  summary: 'Likely duplicate groups, strongest evidence first. Discovery only; dismissed groups are hidden by default.',
  input: { type: 'object', properties: {
    includeDismissed: { type: 'boolean', default: false, description: 'Include groups dismissed in the browser' },
  } },
  run(data, input) {
    return ok({ groups: duplicateGroups(data, input.includeDismissed) });
  },
};
