// month.close — close a month by hand (Review → Close month): added to
// closed_months, and any reopen exception for it dropped. A month that is
// already closed, by hand or by the automatic rule, is refused, and so is one
// that has not ended (the current month or a later one, by the session's
// clock): owner decision 2026-10-05, a month is closed once it is over.

import { ok, fail } from '../result.js';
import { monthKeyErrors } from '../month-fields.js';
import { isMonthClosed, closeMonthPatch, monthHasEnded } from '../closed-periods.js';

export default {
  name: 'month.close',
  summary: 'Close a month (YYYY-MM) so edits to its rows ask first. Only a month that has ended can be closed (month_not_ended for the current or a later month); refused too when it is already closed, by hand or by the automatic rule.',
  input: {
    type: 'object',
    required: ['month'],
    properties: { month: { type: 'string', description: 'Month, YYYY-MM' } },
  },
  execute(data, input, ctx) {
    const { month } = input;
    const bad = monthKeyErrors(month);
    if (bad) return fail('bad_input', { errors: bad });
    if (!monthHasEnded(month, ctx.today)) return fail('month_not_ended', { month });
    if (isMonthClosed(data.meta, month, ctx.today)) {
      return fail('bad_input', { errors: [{ path: 'month', message: `${month} is already closed` }] });
    }
    return ok({ changes: { meta: closeMonthPatch(data.meta, month) }, value: { month } });
  },
};
