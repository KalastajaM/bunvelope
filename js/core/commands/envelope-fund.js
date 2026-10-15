import { ok, fail } from '../result.js';
import funding from '../queries/envelope-funding.js';
import record from './transaction-record.js';

export default {
  name: 'envelope.fund',
  summary: 'Apply a reviewed envelope.funding preview. Requires the exact JSON query value as expected; rechecks at execution time and refuses changed or blocked assessments. Records the same-day envelope transfers atomically through the ordinary transaction command and policies.',
  input: { type: 'object', required: ['envelope', 'expected'], properties: {
    envelope: { type: 'ref', kind: 'envelope' }, source: { type: 'ref', kind: 'envelope' },
    sources: funding.input.properties.sources,
    expected: { type: 'string', description: 'JSON.stringify of the reviewed envelope.funding query value' },
  } },
  execute(data, input, ctx) {
    const fresh = funding.run(data, { envelope: input.envelope, source: input.source, sources: input.sources }, ctx);
    if (!fresh.ok || !fresh.value.preview?.canApply || JSON.stringify(fresh.value) !== input.expected) return fail('funding_preview_changed');
    let current = data;
    const rows = [];
    for (const step of fresh.value.preview.steps) {
      const result = record.execute(current, step.input, ctx);
      if (!result.ok) return result;
      current = { ...current, ...result.value.changes };
      rows.push(result.value.value);
    }
    return ok({ changes: { transactions: current.transactions }, value: rows.length === 1 ? rows[0] : rows });
  },
};
