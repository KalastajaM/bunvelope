import { ok, fail } from '../result.js';
import { RULE_FIELDS, validateImportRule } from '../import-rule-fields.js';
import { deepEqual } from '../diff.js';
export default {
  name: 'importRule.update', summary: 'Edit an import rule. Conditions/actions replace their respective whole objects. No ledger rows change.',
  input: { type: 'object', required: ['id', 'fields'], properties: { id: { type: 'string' }, fields: { type: 'object', properties: RULE_FIELDS } } },
  execute(data, { id, fields }) {
    const rules = data.meta?.importRules;
    if (!Array.isArray(rules) || !rules.some(r => r?.id === id)) return fail('not_found', { kind: 'importRule', id });
    if (rules.filter(r => r?.id === id).length !== 1) return fail('bad_input', { errors: [{ path: 'id', message: 'ambiguous rule id' }] });
    const old = rules.find(r => r?.id === id);
    const next = { ...old, ...fields };
    // A broken rule can always be disabled without validating its old actions.
    const disableOnly = Object.keys(fields).length === 1 && fields.enabled === false;
    const checked = disableOnly ? ok(next) : validateImportRule(data, next, { allowUnavailable: !('conditions' in fields) && !('actions' in fields) && fields.enabled !== true });
    if (!checked.ok) return checked;
    if (deepEqual(old, checked.value)) return ok({ changes: {}, value: { id } });
    return ok({ changes: { meta: { ...data.meta, importRules: rules.map(r => r?.id === id ? checked.value : r) } }, value: { id } });
  },
};
