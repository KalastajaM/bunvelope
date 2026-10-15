import { ok, fail } from '../result.js';
import { evaluateImportRules } from '../import-rules.js';
import { RULE_FIELDS } from '../import-rule-fields.js';
export default {
  name: 'importRules.preview', summary: 'Preview independent import rules against original signed statement rows. Returns explanations, conflicts and a review context; writes nothing.',
  input: { type: 'object', required: ['rows'], properties: {
    rows: { type: 'array', items: { type: 'object', required: ['key', 'payee', 'amount'], properties: {
      key: { type: 'string' }, payee: { type: 'string' }, amount: { type: 'money' }, account: { type: 'string', nullable: true },
      type: { type: 'string', nullable: true }, excluded: { type: 'boolean' },
    } } },
    draft: { type: 'object', required: ['name', 'conditions', 'actions'], properties: { id: { type: 'string' }, ...RULE_FIELDS } },
  } },
  run(data, input) {
    if (new Set(input.rows.map(r => r.key)).size !== input.rows.length) return fail('bad_input', { errors: [{ path: 'rows', message: 'source keys must be unique' }] });
    return ok(evaluateImportRules(data, input.rows, input.draft));
  },
};
