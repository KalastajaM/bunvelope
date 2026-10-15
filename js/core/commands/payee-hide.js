// payee.hide — leave a payee out of pickers and suggestions. Transactions are
// not touched and every total still counts them. Same rule as the sheet's
// setPayeeHidden: the list is lowercased, sorted and unique.

import { ok, fail } from '../result.js';
import { payeeKey, getHiddenPayees, setPayeeHidden } from '../payee-fields.js';

export default {
  name: 'payee.hide',
  summary: 'Hide a payee from pickers and suggestions. Transactions and totals are not touched.',
  input: {
    type: 'object',
    required: ['payee'],
    properties: { payee: { type: 'string', description: 'The payee name (matched ignoring case)' } },
  },
  execute(data, input) {
    if (!payeeKey(input.payee)) return fail('bad_input', { errors: [{ path: 'payee', message: 'needs a payee name' }] });
    if (getHiddenPayees(data.meta).has(payeeKey(input.payee))) return ok({ changes: {}, value: { changed: false } });
    return ok({
      changes: { meta: { ...data.meta, payeeHidden: setPayeeHidden(data.meta.payeeHidden, input.payee, true) } },
      value: { changed: true },
    });
  },
};
