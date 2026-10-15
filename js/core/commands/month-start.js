// Close missed months in order, posting each month's due occurrences before
// its sweep. Later fills are materialised again after each sweep, so a sourced
// set line draws against the balance it actually meets. All changes, including
// the progress marker, are committed atomically by the session.
import { ok } from '../result.js';
import { MONTH_INPUT_PROPERTIES, monthRefDate, monthTombstones } from '../month-fields.js';
import { isoDate } from '../context.js';
import { rolloverRows } from './month-rollover.js';
import { postDueRows } from './month-post-due.js';
import { occurrenceMonthOf } from '../../engine/policies.js';
export { occurrenceMonthOf } from '../../engine/policies.js';

const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const nextMonth = month => {
  const [y, m] = month.split('-').map(Number);
  return isoDate(new Date(y, m, 1)).slice(0, 7);
};

export default {
  name: 'month.start',
  summary: 'Close missed months in order and post what has come due. Returns { adjusted, posted, rows }.',
  payeeAliases: false,
  input: { type: 'object', properties: MONTH_INPUT_PROPERTIES },
  execute(data, input, ctx) {
    const ref = monthRefDate(input, ctx);
    const closingMonth = isoDate(new Date(ref.getFullYear(), ref.getMonth() - 1, 1)).slice(0, 7);
    const checkpoint = data.meta?.last_rollover_month;
    // Legacy rollover rows prove a month was already processed, even when
    // there was no explicit progress marker. Never backfill behind them and
    // silently change the balances that an existing adjustment was based on.
    const legacyClosed = [...data.transactions.map(row => row?.from_budget), ...monthTombstones(data)]
      .filter(key => typeof key === 'string' && /^rollover:.+:\d{4}-(0[1-9]|1[0-2])$/.test(key))
      .map(key => key.slice(-7)).sort().at(-1);
    const knownClosed = validMonth(checkpoint) ? checkpoint : legacyClosed;
    const setupMonth = data.meta?.last_opened_month;
    let month = validMonth(knownClosed) ? nextMonth(knownClosed)
      : validMonth(setupMonth) && setupMonth <= closingMonth ? setupMonth : closingMonth;
    const [firstYear, firstMonth] = month.split('-').map(Number);
    let completed = validMonth(knownClosed) ? knownClosed
      : isoDate(new Date(firstYear, firstMonth - 2, 1)).slice(0, 7);
    let working = data;
    const rows = [];
    let adjusted = 0;
    let posted = 0;
    const append = added => {
      rows.push(...added);
      working = { ...working, transactions: [...working.transactions, ...added] };
    };
    for (; month <= closingMonth; month = nextMonth(month)) {
      // A next-working-day payment can still be ahead of this open. Do not
      // close its month prematurely: the rollover key cannot be rewritten when
      // the payment finally posts. Retry that boundary on the next open.
      if (month === closingMonth) {
        const monthEnd = isoDate(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));
        const waiting = postDueRows(working, { ...input, date: monthEnd }, ctx).some(row =>
          (occurrenceMonthOf(row) ?? '') <= month && row.date > isoDate(ref));
        if (waiting) break;
      }
      // Include all early-dated rows: the engine sets later occurrences aside
      // and replays them after closing this month's own balance. Include late
      // payments owned by this month even when dated in the next one.
      const due = postDueRows(working, input, ctx).filter(row =>
        (occurrenceMonthOf(row) ?? '') <= month || String(row.date).slice(0, 7) <= month);
      append(due);
      posted += due.length;
      const swept = rolloverRows(working, input, ctx, month);
      append(swept);
      adjusted += swept.length;
      completed = month;
    }
    const remaining = postDueRows(working, input, ctx);
    append(remaining);
    posted += remaining.length;
    const advance = completed && completed !== checkpoint;
    return ok({
      changes: {
        ...(rows.length ? { transactions: working.transactions } : {}),
        ...(advance ? { meta: { ...data.meta, last_rollover_month: completed } } : {}),
      },
      value: { adjusted, posted, rows },
    });
  },
};
