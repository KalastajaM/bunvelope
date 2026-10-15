// Cost control is a view of scheduled expense items, never a second ledger.
import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { isoDate } from '../context.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { computeScheduledOccurrences } from '../../engine/scheduling.js';
import { itemDateBounds } from '../../engine/item-dates.js';
import { recurringReminderDays, recurringReminderDates } from '../recurring-review.js';
import { round2 } from '../../utils.js';
import { recurringGroupKey, recurringGroupModes } from '../recurring-categories.js';

export default {
  name: 'recurring.costs',
  summary: 'Scheduled expenses and their next 12 months of planned payments, monthly equivalents, and explicit review, renewal and cancellation reminders. Buffers are excluded. Paused and ended items have zero costs. Hidden items retain their costs but are excluded from tracked totals and have no reminders. Categories group items and return monthly/annual totals excluding hidden items; deadline reminders start reminder_days (default 45) calendar days before renewal, end or cancellation, while review_on starts on its exact date. Reminders do not change the payment schedule.',
  input: { type: 'object', properties: { date: { type: 'date' } } },
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const day = isoDate(ref);
    const end = isoDate(new Date(ref.getFullYear() + 1, ref.getMonth(), ref.getDate() - 1));
    const tombstones = new Set(monthTombstones(data));
    const taken = new Set((data.transactions || []).map(tx => tx.from_budget).filter(Boolean));
    const accounts = new Map((data.accounts || []).map(account => [account.id, account]));
    const envelopes = new Map((data.envelopes || []).map(envelope => [envelope.id, envelope]));
    const items = (data.budgetItems || []).filter(it => it && (it.kind || 'expense') === 'expense' && it.as_schedule).map(it => {
      const bounds = itemDateBounds(it);
      const status = it.include === false ? 'paused' : bounds.until && bounds.until < day ? 'ended' : bounds.since && bounds.since > day ? 'upcoming' : 'active';
      const occurrences = status === 'paused' || status === 'ended' ? [] : computeScheduledOccurrences(it, day, end, { dayType: it.schedule_day_type, country: monthCountry(data) })
        .filter(o => !tombstones.has(`${it.id}:${o.monthKey}`));
      const annual = round2(occurrences.reduce((sum, o) => sum + Math.abs(o.amount), 0));
      const next = occurrences.find(o => !taken.has(`${it.id}:${o.monthKey}`));
      const review = it.recurring_review || {};
      const account = accounts.get(it.account_id);
      const envelope = envelopes.get(it.envelope_id);
      const hidden = review.hidden === true;
      const category = typeof review.category === 'string' ? review.category.trim() || null : null;
      const reminders = hidden || status === 'paused' || status === 'ended' ? [] : recurringReminderDates(review, bounds.until)
        .map(reminder => ({ ...reminder, due: reminder.remindFrom <= day }));
      return { id: it.id, name: it.description || it.id, status, hidden, category, continuous: review.continuous === true, startsOn: review.starts_on || null, annual, monthly: round2(annual / 12), reminderDays: recurringReminderDays(review),
        accountId: it.account_id || null, accountName: account?.name || it.account_id || null,
        envelopeId: it.envelope_id || null, envelopeName: envelope?.name || it.envelope_id || null, envelopeI18nKey: envelope?.i18n_key || null,
        envelopeCategory: envelope?.category?.trim() || null,
        renewsOn: review.continuous ? null : review.renews_on || null,
        next: next ? { date: next.date, amount: round2(Math.abs(next.amount)) } : null,
        reminders, attention: reminders.some(r => r.due), notes: it.recurring_review?.notes || '' };
    });
    const tracked = items.filter(it => !it.hidden);
    const annual = round2(tracked.reduce((sum, it) => sum + it.annual, 0));
    const groups = Object.fromEntries(recurringGroupModes.map(mode => {
      const grouped = new Map();
      for (const item of items) {
        const key = recurringGroupKey(item, mode);
        const label = mode === 'account' ? item.accountName : mode === 'envelope' ? item.envelopeName : mode === 'envelopeCategory' ? item.envelopeCategory : mode === 'category' ? item.category : null;
        if (!grouped.has(key)) grouped.set(key, { key, label, i18nKey: mode === 'envelope' ? item.envelopeI18nKey : null, annual: 0 });
        if (!item.hidden) grouped.get(key).annual += item.annual;
      }
      return [mode, [...grouped.values()].map(group => ({ ...group, annual: round2(group.annual), monthly: round2(group.annual / 12) }))];
    }));
    const categories = groups.category.map(group => ({ key: group.key, category: group.label, annual: group.annual, monthly: group.monthly }));
    return ok({ from: day, through: end, items, categories, groups, totals: { annual, monthly: round2(annual / 12), attention: tracked.filter(it => it.attention).length, tracked: tracked.length, hidden: items.length - tracked.length } });
  },
};
