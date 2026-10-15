// month.clearReopen — drop a month's reopen exception, so the automatic rule
// closes it again (Settings → the reopened months list). The month is removed
// from reopened_months and NOT added to closed_months, which is what separates
// it from month.close. A month with no exception is refused.

import { ok, fail } from '../result.js';
import { monthKeyErrors } from '../month-fields.js';
import { monthList, dropReopenPatch } from '../closed-periods.js';

export default {
  name: 'month.clearReopen',
  summary: 'Drop a month\'s reopen exception (YYYY-MM) so the automatic rule closes it again. Refused when the month has no exception.',
  input: {
    type: 'object',
    required: ['month'],
    properties: { month: { type: 'string', description: 'Month, YYYY-MM' } },
  },
  execute(data, input) {
    const { month } = input;
    const bad = monthKeyErrors(month);
    if (bad) return fail('bad_input', { errors: bad });
    if (!monthList(data.meta?.reopened_months).includes(month)) {
      return fail('bad_input', { errors: [{ path: 'month', message: `${month} has no reopen exception` }] });
    }
    return ok({ changes: { meta: dropReopenPatch(data.meta, month) }, value: { month } });
  },
};
