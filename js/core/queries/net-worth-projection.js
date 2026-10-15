// js/core/queries/net-worth-projection.js — the Net worth page's long-horizon
// projection: net worth once a year for `years` years (year 0 today, year k
// the month-end 12k months after this month's end), as the base line, the
// ±2 % band and a what-if scenario's line, and the per-account table beside
// it (balance, growth rate, monthly contribution, the figure at
// the horizon, a loan's payoff) with its sums and the plan-versus-actual flag.
//
// Years 1 and 2 are the walk's (`simulate`, the Forecast rows stepped day by
// day); later years compound from there by each account's growth rate
// (`growthFor`) and monthly contribution (`contributionFor`, from the plan's
// last simulated year or the last 12 months' average, by `contribution`),
// except that a loan its plan item repays follows its repayment schedule.
// The band moves every rate by ±2 points. The what-if line is the scenario's
// run with the base line's rates and its own run's contributions.
//
// `excludeAccounts` (the page filter) leaves accounts out of the lines and
// the table; the walk still covers every account. `accountOverrides` lays
// unsaved growth and contribution edits over the accounts, for the walk and
// the table alike.
//
// The four runs are the same `simulate` calls `forecast.simulation` makes for
// the plain run, the band (`shiftPct` ±2, `alerts: false`) and the what-if,
// with the same memoised overlay and scenario (js/core/projection.js), so a
// page render that asks both computes each run once.

import { ok, fail } from '../result.js';
import { refDate } from '../lens-input.js';
import {
  ACCOUNT_OVERRIDES_INPUT, withAccountOverrides, whatIfScenarios, NONE, countedAccounts,
  growthFor, contributionFor, amountsOf, cachedAverages, cachedLoanSchedules, cachedLoanPaths,
  contributionTable, planGap,
} from '../projection.js';
import { simulate, projectFromSimulation } from '../../engine/simulation.js';
import { stressCutFor } from '../../engine/stress.js';
import { round2 } from '../../utils.js';

// The band: every rate that is set, moved by this many points.
const SHIFT_PCT = 2;
// The months the walk covers before the long projection takes over.
const SIM_MONTHS = 24;

export default {
  name: 'netWorth.projection',
  summary: 'Net worth once a year for the given number of years, each line one { year, total } per year (year 0 today, year k the month-end 12k months after this month\'s end): base (the plan walked 24 months, then each account compounding by its growth rate and adding its monthly contribution; a loan its plan item repays follows its schedule), low and high (every rate ±2 points), and whatIf (a saved what-if scenario\'s line) or null. accounts: per non-archived account the balance today, growth rate (growthSource set = its own, interest = from its interest tiers), monthly contribution (contributionSource set = its own, plan = the plan\'s last simulated year, history = the last 12 months\' average, none = an asset), both suggestions (plan, history), its figure at the horizon, a scheduled loan\'s payoffDate, and whether the table shows it. table: the shown rows\' monthly sums (used = what the projection adds, plan, actual = the last 12 months) and gap, the plan adding far less than the last 12 months.',
  input: {
    type: 'object',
    required: ['years'],
    properties: {
      years: { type: 'integer', minimum: 1, maximum: 50, description: 'How many years to project (1-50)' },
      contribution: { enum: ['plan', 'history'], default: 'plan', description: 'plan = the plan\'s last simulated year; history = the last 12 months\' average (default plan)' },
      whatIf: { type: 'string', description: 'A saved what-if scenario id, for its own line' },
      date: { type: 'date', description: 'The day the projection starts (YYYY-MM-DD, default today)' },
      excludeAccounts: { type: 'array', items: { type: 'ref', kind: 'account' }, description: 'Accounts left out of the lines and the table (not out of the walk)' },
      accountOverrides: ACCOUNT_OVERRIDES_INPUT,
    },
  },
  /**
   * @param {any} data
   * @param {{ years: number, contribution: 'plan' | 'history', whatIf?: string, date?: string,
   *           excludeAccounts?: string[], accountOverrides?: import('../projection.js').AccountOverride[] }} input
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
    const { years, contribution: source } = input;
    const { source: simSource, accounts: live } = withAccountOverrides(data, input.accountOverrides);
    // forecast.simulation's runs, argument for argument (the cache key).
    const runOf = (/** @type {number} */ shiftPct, /** @type {import('../../engine/whatif.js').WhatIfScenario | null} */ sc) => simulate({
      source: simSource, today, months: SIM_MONTHS, shiftPct, trackAlerts: shiftPct === 0,
      ...(sc ? { scenario: sc, stressCut: stressCutFor } : {}),
    });
    const sims = { low: runOf(-SHIFT_PCT, null), base: runOf(0, null), high: runOf(SHIFT_PCT, null) };
    const whatIfSim = scenario ? runOf(0, scenario) : null;

    // The lines sum the stored accounts less the excluded (the engine skips
    // archived ones); the table and the rate and contribution maps are the
    // non-archived ones with the overrides laid over them. The 12-month
    // average and the loan schedules read the stored accounts, and are
    // memoised on them: a horizon or source toggle reuses both.
    const counted = countedAccounts(stored, input.excludeAccounts);
    const accounts = countedAccounts(live, input.excludeAccounts).filter(a => a && !a.archived);
    const transactions = data.transactions || NONE;
    const averages = cachedAverages(stored, input.excludeAccounts, transactions, today);
    const schedules = cachedLoanSchedules(stored, input.excludeAccounts, {
      budgetItems: data.budgetItems || NONE, transactions, today, country: data.meta?.country ?? 'FI',
    });
    const scheduled = cachedLoanPaths(schedules, today, years * 12 + 1);

    /** @type {Map<string, number | null>} */
    const growth = new Map(accounts.map(a => [a.id, growthFor(a, sims.base.opening.accounts.get(a.id) ?? 0).pct]));
    const contributionsOf = (/** @type {import('../../engine/simulation.js').Simulation} */ sim) => new Map(accounts.map(a => [
      a.id, contributionFor(a, amountsOf(a.id, sim.lastYearContribution, averages), source).amount,
    ]));
    const contribution = contributionsOf(sims.base);
    const line = (/** @type {import('../../engine/simulation.js').Simulation} */ sim, /** @type {number} */ shiftPct, contrib = contribution) => projectFromSimulation({
      accounts: counted, sim, growthPct: growth, contribution: contrib, years, shiftPct, scheduled,
    });

    const table = contributionTable(accounts, {
      opening: sims.base.opening.accounts, lastYearContribution: sims.base.lastYearContribution, averages, source,
    });
    const rows = table.rows.map(({ account, balance, growth: g, amounts, contribution: c, shown }) => {
      const single = projectFromSimulation({ accounts: [account], sim: sims.base, growthPct: growth, contribution, years, scheduled });
      const schedule = schedules.get(account.id);
      return {
        id: account.id,
        balance: round2(balance),
        growthPct: g.pct,
        growthSource: g.source,
        contribution: round2(c.amount),
        contributionSource: c.source,
        plan: round2(amounts.plan),
        history: round2(amounts.history),
        atHorizon: single[single.length - 1].total,
        loan: schedule ? { payoffDate: schedule.payoffDate } : null,
        shown,
      };
    });

    return ok({
      years,
      base: line(sims.base, 0),
      low: line(sims.low, -SHIFT_PCT),
      high: line(sims.high, SHIFT_PCT),
      whatIf: whatIfSim ? line(whatIfSim, 0, contributionsOf(whatIfSim)) : null,
      accounts: rows,
      table: { used: table.used, plan: table.plan, actual: table.actual, gap: planGap(table) },
    });
  },
};
