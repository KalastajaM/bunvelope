import { ok, fail } from '../result.js';
import { RULE_FIELDS, validateImportRule } from '../import-rule-fields.js';
export default {
  name: 'importRule.create', summary: 'Save an optional import naming/envelope rule. Existing transactions are unchanged.',
  input: { type: 'object', required: ['name', 'conditions', 'actions'], properties: RULE_FIELDS },
  execute(data, input, ctx) {
    const rules = data.meta?.importRules ?? [];
    if (!Array.isArray(rules)) return fail('bad_input', { errors: [{ path: 'importRules', message: 'stored rules are malformed' }] });
    const valid = validateImportRule(data, input); if (!valid.ok) return valid;
    const id = ctx.newId();
    if (rules.some(r => r?.id === id)) return fail('bad_input', { errors: [{ path: 'id', message: 'duplicate rule id' }] });
    return ok({ changes: { meta: { ...data.meta, importRules: [...rules, { ...valid.value, id }] } }, value: { id } });
  },
};
