// transaction.import — many recorded rows in one step: a CSV or statement
// import, an approved AI proposal. Each row is a transaction.record input and
// is built by the same helper, but the rows are appended together, so the
// session's commit checks (aliases, normalisation, validation) run once over
// the ledger instead of once per row. A batch of N record steps re-checks the
// whole ledger N times: 6.5 s for 500 rows on a 20,000-row ledger.

import { importRuleContext } from '../import-rules.js';
import { statementReviewContext } from '../statement-review-context.js';
import { ok, fail } from '../result.js';
import { RECORD_INPUT_PROPERTIES, buildRecordedRow } from '../tx-record.js';

const { force, ...ROW_PROPERTIES } = RECORD_INPUT_PROPERTIES;

export default {
  name: 'transaction.import',
  summary: 'Record many transactions at once, each exactly as transaction.record would (same fields, same checks). All rows are appended in order; one refused row refuses the import and changes nothing. Returns the new rows.',
  input: {
    type: 'object',
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        description: 'The transactions to record (at least one); each is a transaction.record input without force. The CLI resolves schema-declared references inside rows and splits from names or ids; direct core/session callers supply ids',
        items: { type: 'object', required: ['type', 'amount'], properties: ROW_PROPERTIES },
      },
      expectedImportContext: { type: 'string', description: 'Optional importRules.preview context; refuses a stale review without changing its approved inputs' },
      expectedStatement: { type: 'object', required: ['account', 'context'], properties: {
        account: { type: 'ref', kind: 'account' }, context: { type: 'string' },
      }, description: 'Optional import.review account and context; refuses changed ledger or alias inputs at commit time' },
      force,
    },
  },
  execute(data, input, ctx) {
    if (input.expectedImportContext !== undefined && input.expectedImportContext !== importRuleContext(data)) return fail('import_review_changed');
    if (input.expectedStatement && input.expectedStatement.context !== statementReviewContext(data, input.expectedStatement.account)) return fail('import_review_changed');
    if (input.rows.length === 0) {
      return fail('bad_input', { errors: [{ path: 'rows', message: 'needs at least one row' }] });
    }
    const rows = [];
    for (const [i, item] of input.rows.entries()) {
      const built = buildRecordedRow(item, ctx, data);
      if (!built.ok) return fail(built.error.code, { ...built.error.params, row: i });
      rows.push(built.value);
    }
    return ok({ changes: { transactions: [...data.transactions, ...rows] }, value: { rows } });
  },
};
