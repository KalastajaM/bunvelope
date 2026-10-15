// month.reopen — reopen a closed month: a manual close is dropped, and a month
// the automatic rule still closes gets an exception in reopened_months. Which
// months the rule closes depends on today, so the command's own date decides.
// A month that is not closed is refused.

import { ok, fail } from '../result.js';
import { monthKeyErrors } from '../month-fields.js';
import { isMonthClosed, reopenMonthPatch } from '../closed-periods.js';

export default {
  name: 'month.reopen',
  summary: 'Reopen a closed month (YYYY-MM). A month the automatic rule closes gets a reopen exception. Refused when the month is not closed.',
  input: {
    type: 'object',
    required: ['month'],
    properties: { month: { type: 'string', description: 'Month, YYYY-MM' } },
  },
  execute(data, input, ctx) {
    const { month } = input;
    const bad = monthKeyErrors(month);
    if (bad) return fail('bad_input', { errors: bad });
    if (!isMonthClosed(data.meta, month, ctx.today)) {
      return fail('bad_input', { errors: [{ path: 'month', message: `${month} is not closed` }] });
    }
    return ok({ changes: { meta: reopenMonthPatch(data.meta, month, ctx.today) }, value: { month } });
  },
};
