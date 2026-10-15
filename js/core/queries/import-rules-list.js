import { ok } from '../result.js';
import { listImportRules } from '../import-rules.js';
export default { name: 'importRules.list', summary: 'List import rules and unavailable reference diagnostics.', input: { type: 'object', properties: {} }, run: data => ok(listImportRules(data)) };
