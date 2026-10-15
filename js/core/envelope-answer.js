// js/core/envelope-answer.js — the JSON shapes of the engine's per-envelope
// figures that more than one query answers with: an envelope's goal progress
// and its item funding (`envelopes.month` per row, `envelope.health` for one
// envelope). Money in cents; ratios, dates and statuses as the engine returns
// them.

import { round2 } from '../utils.js';

/** @param {number | null | undefined} n */
const money = (n) => (n == null ? null : round2(n));

/**
 * computeEnvelopeGoalProgress's answer, or null when the envelope has no goal.
 * @param {any} g
 */
export function goalAnswer(g) {
  if (!g) return null;
  return {
    goalAmount: round2(g.goalAmount),
    goalDate: g.goalDate,
    balance: round2(g.balance),
    fraction: g.fraction,
    monthlyRequired: money(g.monthlyRequired),
    daysRemaining: g.daysRemaining,
    status: g.status,
  };
}

/**
 * computeItemFunding's EnvelopeFunding, or null.
 * @param {any} f
 */
export function fundingAnswer(f) {
  if (!f) return null;
  return {
    items: f.items.map((/** @type {any} */ i) => ({
      itemId: i.itemId,
      name: i.name,
      style: i.style,
      planThisMonth: round2(i.planThisMonth),
      spent: round2(i.spent),
      remaining: round2(i.remaining),
      overspent: round2(i.overspent),
      allocated: round2(i.allocated),
      pct: i.pct,
      status: i.status,
      shortBy: round2(i.shortBy),
      shortDate: i.shortDate,
      nextDue: i.nextDue ? { date: i.nextDue.date, amount: round2(i.nextDue.amount) } : null,
    })),
    reserve: round2(f.reserve),
    reserveAllocated: round2(f.reserveAllocated),
    unassigned: round2(f.unassigned),
    shortfall: round2(f.shortfall),
    unlinkedSpent: round2(f.unlinkedSpent),
  };
}
