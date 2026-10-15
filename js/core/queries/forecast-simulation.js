// js/core/queries/forecast-simulation.js — the projection walk (engine
// `simulate`): the Forecast rows stepped day by day from `date` through
// `months` months, with interest and value growth, as the Net worth page's
// "Next 24 months" card and the Dashboard's date to act on read it.
//
// The walk always covers every account; `excludeAccounts` (the page filter)
// narrows only the month-end totals and parts, never the walk or its dates to
// act on. `shiftPct` moves every growth rate (the ±2 % band); `alerts: false`
// skips the dates to act on, as the band runs do. `whatIf` is a saved
// scenario's id (`meta.whatIfScenarios`, cleaned by `normalizeScenarios`):
// the answer is then that scenario's run, with `alertsDiff`, how its dates to
// act on differ from the plain run's. `accountOverrides` lays unsaved growth
// and contribution edits over the accounts before the walk.
//
// `simulate` caches on the identity of its inputs, and a run's cost is a
// 24-month walk, so this passes the snapshot's own arrays, the memoised
// overlay and scenario (js/core/projection.js) and the module-level stress
// cut; with default inputs it is the same cache entry the Net worth page's
// base run uses.

import { ok, fail } from '../result.js';
import { refDate } from '../lens-input.js';
import {
  ACCOUNT_OVERRIDES_INPUT, withAccountOverrides, whatIfScenarios, NONE, countedAccounts, roundedPoint,
} from '../projection.js';
import { simulate } from '../../engine/simulation.js';
import { netWorthFromBalances } from '../../engine/balances.js';
import { diffAlerts } from '../../engine/whatif.js';
import { stressCutFor } from '../../engine/stress.js';

/**
 * A plain copy of a run's dates to act on: the answer must not hand out the
 * cached run's own objects.
 * @param {import('../../engine/simulation.js').SimAlert[]} alerts
 */
const copyAlerts = (alerts) => alerts.map(a => ({ ...a }));

export default {
  name: 'forecast.simulation',
  summary: 'The projection walk: the Forecast rows stepped day by day from date through months months, with interest and value growth. points: net worth at each month-end (total and its parts) over the non-archived accounts, less excludeAccounts. alerts: the dates to act on (an account or Unallocated going negative, an envelope below its floor, crisis cash below its target) over every account, whatever is excluded; empty with alerts false. shiftPct moves every growth rate. whatIf runs a saved what-if scenario instead, with alertsDiff: its dates to act on added, removed or moved against the plain run\'s.',
  input: {
    type: 'object',
    properties: {
      months: { type: 'integer', minimum: 1, maximum: 60, default: 24, description: 'How many months to walk after date\'s month (1-60, default 24)' },
      shiftPct: { type: 'number', minimum: -20, maximum: 20, default: 0, description: 'Percentage points added to every growth rate (default 0)' },
      whatIf: { type: 'string', description: 'A saved what-if scenario id' },
      date: { type: 'date', description: 'The day the walk starts (YYYY-MM-DD, default today)' },
      excludeAccounts: { type: 'array', items: { type: 'ref', kind: 'account' }, description: 'Accounts left out of the totals and parts (not out of the walk or the dates to act on)' },
      accountOverrides: ACCOUNT_OVERRIDES_INPUT,
      alerts: { type: 'boolean', default: true, description: 'Track the dates to act on (default true)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ months: number, shiftPct: number, whatIf?: string, date?: string, excludeAccounts?: string[],
   *           accountOverrides?: import('../projection.js').AccountOverride[], alerts: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const stored = data.accounts || NONE;
    /** @type {import('../../engine/whatif.js').WhatIfScenario | null} */
    let scenario = null;
    if (input.whatIf !== undefined) {
      scenario = whatIfScenarios(data.meta?.whatIfScenarios, stored, data.budgetItems || NONE).find(s => s.id === input.whatIf) || null;
      if (!scenario) return fail('not_found', { kind: 'whatIf', id: input.whatIf });
    }

    const today = refDate(input, ctx);
    const { source, accounts } = withAccountOverrides(data, input.accountOverrides);
    const runOf = (/** @type {import('../../engine/whatif.js').WhatIfScenario | null} */ sc) => simulate({
      source, today, months: input.months, shiftPct: input.shiftPct, trackAlerts: input.alerts,
      // The plain run passes neither, as the page's base run does: the cache
      // compares them by identity, and null is not undefined.
      ...(sc ? { scenario: sc, stressCut: stressCutFor } : {}),
    });
    const sim = runOf(scenario);

    const counted = countedAccounts(accounts, input.excludeAccounts);
    const points = sim.monthly.map(p => roundedPoint(p.date, netWorthFromBalances(counted, p.accounts)));

    const alerts = input.alerts ? copyAlerts(sim.alerts) : [];
    const alertsDiff = scenario && input.alerts ? diffAlerts(copyAlerts(runOf(null).alerts), alerts) : null;
    return ok({
      start: sim.startDate,
      end: sim.endDate,
      points,
      alerts,
      whatIf: scenario ? { id: scenario.id, name: scenario.name } : null,
      alertsDiff,
    });
  },
};
