import { MONTHS } from '../engine/stress.js';
import { shiftRecurringDate } from './recurring-discovery.js';

// AI values are only an editor draft, never a command or a write. Unknown and
// weekly cadences stay unscheduled: the monthly Plan cannot represent them.
export function subscriptionDraft(candidate, data, today) {
  const period = new Map([['monthly', 1], ['quarterly', 3], ['yearly', 12]]).get(candidate?.frequency);
  const first = shiftRecurringDate(today.slice(0, 8) + '01', 1);
  const month = Number(first.slice(5, 7)) - 1;
  const amount = Number(candidate?.amount);
  return {
    description: typeof candidate?.payee === 'string' ? candidate.payee.trim().slice(0, 500) : '',
    default_amount: Number.isFinite(amount) && amount > 0 ? -amount : 0,
    envelope_id: data.envelopes.some(e => e.id === candidate?.envelope_id && !e.archived) ? candidate.envelope_id : null,
    account_id: null, as_schedule: !!period, start_month: first.slice(0, 7), payment_day: 1,
    monthly_schedule: Object.fromEntries(MONTHS.map((name, index) => [name, period ? (index - month + 12) % period === 0 : false])),
  };
}
