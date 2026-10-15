// payee.unhide — bring a hidden payee back into pickers and suggestions. Same
// rule as the sheet's setPayeeHidden. A payee that is not hidden changes
// nothing.

import { ok, fail } from '../result.js';
import { payeeKey, getHiddenPayees, setPayeeHidden } from '../payee-fields.js';

export default {
  name: 'payee.unhide',
  summary: 'Show a hidden payee in pickers and suggestions again.',
  input: {
    type: 'object',
    required: ['payee'],
    properties: { payee: { type: 'string', description: 'The payee name (matched ignoring case)' } },
  },
  execute(data, input) {
    if (!payeeKey(input.payee)) return fail('bad_input', { errors: [{ path: 'payee', message: 'needs a payee name' }] });
    if (!getHiddenPayees(data.meta).has(payeeKey(input.payee))) return ok({ changes: {}, value: { changed: false } });
    return ok({
      changes: { meta: { ...data.meta, payeeHidden: setPayeeHidden(data.meta.payeeHidden, input.payee, false) } },
      value: { changed: true },
    });
  },
};
