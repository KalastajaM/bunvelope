import { ok, fail } from '../result.js';
import { LENS_INPUT, lensRows } from '../lens-input.js';
import { comparisonData, COMPARISON_VERSION } from '../comparison.js';

export default {
  name: 'comparison.save',
  summary: 'Save or replace the budget’s single comparison point, including the current calendar date and balance view. Copies calculation inputs into meta; does not change balances. Included in budget exports. Prior edits cannot be explained before the first save.',
  input: { type: 'object', properties: { ...LENS_INPUT } },
  execute(data, input, ctx) {
    const checked = lensRows(data, input, ctx);
    if (!checked.ok) return checked;
    const view = { lens: input.lens || 'booked', ...(input.horizon === undefined ? {} : { horizon: input.horizon }) };
    const comparisonPoint = { version: COMPARISON_VERSION, at: ctx.now.toISOString(), date: ctx.todayIso, view, data: comparisonData(data) };
    // Bound extra storage: one snapshot, no unbounded revision history.
    if (new TextEncoder().encode(JSON.stringify(comparisonPoint)).length > 8 * 1024 * 1024) {
      return fail('bad_input', { errors: [{ path: 'comparison', message: 'Comparison point exceeds 8 MiB.' }] });
    }
    return ok({ changes: { meta: { ...data.meta, comparisonPoint } }, value: { at: comparisonPoint.at, date: comparisonPoint.date, view } });
  },
};
