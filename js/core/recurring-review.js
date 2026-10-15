// Shared date-only rules for the query and the editor's reminder preview.
import { isoDate } from './context.js';
import { parseDate } from '../utils.js';

/** @param {any} review */
export function recurringReminderDays(review) {
  const days = review?.reminder_days;
  return Number.isInteger(days) && days >= 0 && days <= 3650 ? days : 45;
}

/** Calendar-day difference, independent of daylight-saving clock changes. */
export function recurringLeadDays(deadline, reminder) {
  const a = parseDate(deadline), b = parseDate(reminder);
  if (!a || !b) return null;
  const day = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(a) - day(b)) / 86400000);
}

/** The single deadline used by linked reminders.
 * @param {any} review
 * @param {string | null} fallbackEnd
 */
export function recurringDeadline(review, fallbackEnd = null) {
  if (review.continuous) return null;
  const kind = review.renews_on ? 'renews_on' : 'ends_on';
  const date = review.renews_on || review.ends_on || fallbackEnd;
  if (review.cancel_by && (!date || review.cancel_by < date)) return { kind: 'cancel_by', date: review.cancel_by };
  return date ? { kind, date } : null;
}

/** @param {any} review
 * @param {string | null} fallbackEnd
 */
export function recurringReminderDates(review = {}, fallbackEnd = null) {
  const days = recurringReminderDays(review);
  const linked = review.linked_reminder || review.continuous;
  const deadline = linked ? recurringDeadline(review, fallbackEnd) : null;
  const dates = linked
    ? (deadline ? { [deadline.kind]: deadline.date } : { review_on: review.review_on })
    : { ...review, ends_on: review?.ends_on || fallbackEnd };
  return ['review_on', 'cancel_by', 'renews_on', 'ends_on'].flatMap(kind => {
    const date = dates[kind];
    const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseDate(date) : null;
    if (!parsed || isoDate(parsed) !== date) return [];
    // Local calendar arithmetic handles DST and year/month boundaries.
    const from = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() - (kind === 'review_on' ? 0 : days));
    return [{ kind, date, remindFrom: isoDate(from) }];
  }).sort((a, b) => a.remindFrom.localeCompare(b.remindFrom) || a.date.localeCompare(b.date));
}
