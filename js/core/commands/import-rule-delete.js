import { ok, fail } from '../result.js';
export default {
  name: 'importRule.delete', summary: 'Delete an import rule without changing existing transactions.',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  execute(data, { id }) {
    const rules = data.meta?.importRules;
    if (!Array.isArray(rules) || !rules.some(r => r?.id === id)) return fail('not_found', { kind: 'importRule', id });
    if (rules.filter(r => r?.id === id).length !== 1) return fail('bad_input', { errors: [{ path: 'id', message: 'ambiguous rule id' }] });
    return ok({ changes: { meta: { ...data.meta, importRules: rules.filter(r => r?.id !== id) } }, value: { id } });
  },
};
