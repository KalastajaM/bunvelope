// payee.unalias — forget a remembered spelling: new rows with it stop being
// renamed. Same rule as the sheet's removePayeeAlias. Forgetting a spelling
// that is not an alias changes nothing.

import { ok, fail } from '../result.js';
import { payeeKey, getPayeeAliases, removePayeeAlias } from '../payee-fields.js';

export default {
  name: 'payee.unalias',
  summary: 'Forget a remembered payee spelling (an alias): new rows with it stop being renamed.',
  input: {
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string', description: 'The aliased spelling (matched ignoring case)' } },
  },
  execute(data, input) {
    if (!payeeKey(input.key)) return fail('bad_input', { errors: [{ path: 'key', message: 'needs a payee spelling' }] });
    const aliases = getPayeeAliases(data.meta);
    if (!Object.hasOwn(aliases, payeeKey(input.key))) return ok({ changes: {}, value: { changed: false } });
    return ok({
      changes: { meta: { ...data.meta, payeeAliases: removePayeeAlias(aliases, input.key) } },
      value: { changed: true },
    });
  },
};
