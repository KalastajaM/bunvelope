import { assignShortCode } from '../short-codes.js';
// account.create — a new account. The id is made from the name as the form
// makes it, the name must be unique, and the fields are stored as the form
// stores them (applyAccountFields).

import { ok, fail } from '../result.js';
import {
  ACCOUNT_FIELD_PROPERTIES, applyAccountFields, accountRuleErrors, checkName, newAccountId, trimAccountText,
} from '../entity-fields.js';

export default {
  name: 'account.create',
  summary: 'Create an account. type defaults to bank and initialBalance to 0; the id is made from the name, which must be unique (case-insensitive, archived accounts included). Fields that do not belong to the type are not stored.',
  input: {
    type: 'object',
    required: ['name'],
    properties: {
      ...ACCOUNT_FIELD_PROPERTIES,
      type: { ...ACCOUNT_FIELD_PROPERTIES.type, default: 'bank' },
      initialBalance: { ...ACCOUNT_FIELD_PROPERTIES.initialBalance, default: 0 },
    },
  },
  execute(data, input) {
    const codeResult = assignShortCode(data, 'account', trimAccountText(input));
    if (!codeResult.ok) return codeResult;
    const fields = codeResult.value;
    const bad = checkName('account', data.accounts, fields.name);
    if (bad) return fail(bad.code, bad.params);
    const id = newAccountId(data.accounts, fields.name);
    const account = applyAccountFields({ id, name: fields.name, type: fields.type, initialBalance: fields.initialBalance, notes: '' }, fields);
    // The form omits empty notes.
    if (account.notes === '') delete account.notes;
    const errors = accountRuleErrors(account, data.accounts);
    if (errors.length) return fail('bad_input', { errors });
    return ok({ changes: { accounts: [...data.accounts, account] }, value: { id } });
  },
};
