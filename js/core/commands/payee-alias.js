// payee.alias — remember one spelling as an alias of a kept name, so the next
// import or manual entry with it arrives renamed (new rows only; existing rows
// change only through payee.merge). Same rules as the sheet's addPayeeAliases.

import { ok, fail } from '../result.js';
import { addPayeeAliases, getPayeeAliases } from '../payee-fields.js';
import { deepEqual } from '../diff.js';

export default {
  name: 'payee.alias',
  summary: 'Remember a payee spelling as an alias of another name: new rows with that spelling arrive renamed. Existing rows are not changed (use payee.merge for those).',
  input: {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', description: 'The spelling to rename' },
      to: { type: 'string', description: 'The name to keep' },
    },
  },
  execute(data, input) {
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!input.from.trim()) errors.push({ path: 'from', message: 'needs a payee spelling' });
    if (!input.to.trim()) errors.push({ path: 'to', message: 'needs a payee name' });
    if (errors.length) return fail('bad_input', { errors });
    const to = input.to.trim();
    const meta = { ...data.meta, payeeAliases: addPayeeAliases(getPayeeAliases(data.meta), [input.from], to) };
    if (deepEqual(meta.payeeAliases, getPayeeAliases(data.meta))) return ok({ changes: {}, value: { changed: false } });
    return ok({ changes: { meta }, value: { changed: true } });
  },
};
