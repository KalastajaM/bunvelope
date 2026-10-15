// js/ui/envelope-meter.js — the state an envelope card (grid or list row)
// shows: its colour class and how full its meter is. One rule for both
// views, so they cannot disagree.
//
// The meter is a SPEND meter: it fills as the month's plan is spent. It used
// to be forced to a full green "funded" bar whenever balance ≥ plan, which
// put a full green bar beside a red "−€50 short" and a red "€81,61 of
// €75,00 spent" (Car Charging, 2026-09-29). Now it always shows spent/plan;
// spending past the plan fills it red; and "funded" (green) needs the
// envelope to be neither short nor over its plan.
//
// "The month's plan" is the month's own calendar entry (`monthPlanned`), not
// the annual average: two €100 allowances paid on 1 Oct, due twice a year,
// read "€200,00 of €33,33 spent" and a full red bar beside "2 of 2 items on
// track" (Allowance Boys, 2026-10-04). Tight and funded still weigh the
// balance against the average month, a steady measure of what it holds.
//
// Pure: no DOM.

/**
 * @param {{ balance: number, planned: number, monthPlanned?: number | null,
 *   spent?: number | null, spare?: { spare?: number } | null,
 *   balanceCovered?: boolean }} input  `monthPlanned` defaults to `planned`
 * @returns {{ isOver: boolean, isTight: boolean, isFunded: boolean,
 *   overPlan: boolean, meterPct: number }}
 */
export function envelopeMeterState({ balance, planned, monthPlanned = null, spent = null, spare = null, balanceCovered = false }) {
  const plan = planned || 0;
  const monthPlan = Number.isFinite(monthPlanned) ? /** @type {number} */ (monthPlanned) : plan;
  const sp = Number.isFinite(spent) ? /** @type {number} */ (spent) : Math.max(0, monthPlan - (balance || 0));
  const isOver = balance < -0.005 && !balanceCovered;
  const overPlan = monthPlan > 0 && Number.isFinite(spent) && /** @type {number} */ (spent) > monthPlan + 0.005;
  // Overspent (spent > the month's plan) is one state with one colour, red,
  // whatever the balance: "€400 of €100 spent" with an empty envelope read
  // orange (tight) while "€500 of €201" read red. So an overspent envelope
  // is not also tight.
  const isTight = !isOver && !overPlan && !balanceCovered && plan > 0 && (balance / plan) < 0.2;
  const short = !!spare && Number.isFinite(spare.spare) && /** @type {number} */ (spare.spare) < -0.005;
  const isFunded = !isOver && !short && !overPlan && plan > 0 && balance >= plan;
  const spendPct = monthPlan > 0 ? Math.max(0, Math.min(100, (sp / monthPlan) * 100)) : 0;
  return { isOver, isTight, isFunded, overPlan, meterPct: overPlan ? 100 : spendPct };
}
