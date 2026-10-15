// engine.js — Budget math engine.
//
// Pure functions only. No DOM, no I/O.
//
// The engine is split into focused submodules under `js/engine/`. This file
// is a thin facade that re-exports their public API so existing call sites
// (~50 importers) keep working unchanged.
//
// Schema v3 vocabulary:
//   envelope   = bucket { id, name, category, description?, archived? }
//   budgetItem = regular expense mapped to an envelope:
//                { id, envelope_id, description?, default_amount,
//                  monthly_schedule, extra_buffer, include, include_in_emergency_budget,
//                  payment_day, stress_category, stress_cut_pct }
//   tx         = transaction. Envelope references use `envelope_id` (and
//                `from_envelope_id` / `to_envelope_id` / fill line `envelope_id`).
//                Adjustments with target === 'envelope' use `target_id` = envelope_id.
//
// Sign convention: `tx.amount` stores a positive magnitude for type-signed
// transactions (expense, income, transfers, fill, etc.) and a signed value
// only for `adjustment`. Always read magnitudes/deltas through `txAbsAmount`
// / `txAccountDelta` (in `engine/tx-amounts.js`) — never `tx.amount` directly.

// Transaction sign helpers + normalisation + interest projection.
export {
  txAbsAmount,
  txDirection,
  isPostedTx,
  normalizeTxAmount,
  normalizeTransactionsForWrite,
  txFeeAmount,
  computeAnnualInterest,
  txAccountDelta,
  txNetAccountDelta,
  TX_TYPES,
  isKnownTxType,
} from './engine/tx-amounts.js';

// Hashtag extraction from transaction notes.
export {
  extractTxTags,
  txHasTag,
  collectAllTags,
} from './engine/tx-tags.js';

// Income classification for budget items. Public because page code genuinely
// needs it: an item is income-like if `kind === 'income'` OR it is a
// dividend-direction investment transfer, and a bare `kind === 'income'` test
// silently misfiles dividends as expenses. `js/pages/stress.js` did exactly
// that and understated runway in every scenario, which is why this now lives
// on the facade rather than only inside `engine/_constants.js`.
export { isIncomeLikeItem, CENT_EPSILON, isZeroMoney, loanItemsByLoanAccount } from './engine/_constants.js';

// The balance lens — the single seam that resolves a display mode
// (today / booked / forecast) into the transaction array to walk.
export {
  LENS_TODAY,
  LENS_BOOKED,
  LENS_FORECAST,
  LENSES,
  DEFAULT_LENS,
  HORIZONS,
  DEFAULT_HORIZON,
  normalizeLens,
  normalizeHorizon,
  resolveHorizonDate,
  lensTransactions,
  resolveEnvelopeAccounts,
} from './engine/lens.js';

// Envelope + account balances and the unallocated derivation.
export {
  computeEnvelopeBalances,
  computeEnvelopeRunningBalances,
  txEnvelopeEffect,
  txEnvelopeIds,
  txEnvelopeSpend,
  txSpendPairs,
  txSpendTotal,
  computeSpentThisMonthByEnvelope,
  txConsumptionPairs,
  txConsumptionTotal,
  isSpendingAccount,
  isCrisisCashAccount,
  spendingByDefault,
  computeAccountBalances,
  computeAccountBalancesAsOf,
  computeAccountBalancesAtDates,
  computeAccountRunningBalances,
  computeUnallocated,
  countsTowardIdentity,
  identityAccountTotal,
  computeSavingsSplit,
  computeNetWorth,
  netWorthFromBalances,
  netWorthPartOf,
  computeNetWorthHistory,
  averageMonthlyContribution,
  projectNetWorth,
  isAssetAccount,
  isLoanAccount,
  isLoanGivenAccount,
  loanAccountIds,
  filterTransactions,
} from './engine/balances.js';

// Fill %: how far an envelope's balance covers each of its budget items.
export {
  computeItemFunding,
  computeItemFundingByEnvelope,
  resolveFundingStyle,
  envelopeFundingItems,
} from './engine/item-funding.js';

// The projection walk: 24 months of Forecast rows plus balance-dependent
// interest and growth, dates to act on, and the hand-off to the long
// net-worth projection.
export { simulate, projectFromSimulation } from './engine/simulation.js';

// Credit cards paid off monthly in the forecast from their `settledFrom`
// account (the Forecast lens adds the rows), and the rule behind them.
export { SETTLED_TYPES, canPayCards, cardFundingFor, cardSettlementRows, withCardSettlements } from './engine/card-settlement.js';

// What-if scenarios: a transform of the simulation's forecast rows, the
// saved scenarios read defensively, and how two runs' dates to act on differ.
export { normalizeScenarios, applyScenario, diffAlerts } from './engine/whatif.js';

// The stress-scenarios model: cut resolution, the draft mutators and the
// plan-item list helpers; `stressCutFor` is the what-if simulation's cut.
export {
  MONTHS, SCENARIOS, CAT_CHOICES, clampFrac, isTransferItem, scenarioHits, cutScenariosFor, stressCutPct,
  setStressCutPct, itemsNeedingCutExpansion, itemsWithFlatLadder, expandFlatCuts, clearStressCuts,
  annualAmount, adjustedAnnual, stressCutFor,
} from './engine/stress.js';

// Investment-holding aggregation.
export {
  txSymbol,
  computeHoldings,
  listHoldings,
  holdingPrice,
  holdingMarkPrice,
  holdingValue,
  summarizeHoldings,
  portfolioValueByAccount,
} from './engine/holdings.js';

// Annual / monthly planning math, emergency-fund requirement, full review.
export {
  computeAnnual,
  computeAnnualTotals,
  annualByEnvelope,
  computeDynamicTemplateLines,
  resolveTemplateLines,
  computeMonthlyPlanByEnvelope,
  buildExpenseCalendar,
  toRollingSchedule,
  calcDepositAndRequired,
  computeBufferByEnvelope,
  computeMonthlyEmergencyAmount,
  runMonthlyReview,
  computeEmergencyFundRequirement,
  rollForwardEnvelopeBalances,
} from './engine/monthly-review.js';

// Frequency classification, rollover policy, savings-goal progress.
export {
  FREQUENCY_ORDER,
  classifyFrequency,
  applyEnvelopeRollovers,
  computeEnvelopeGoalProgress,
} from './engine/policies.js';

// Banking-day calendar, occurrence walking, materialise + forecast.
export {
  workingDayAdjust,
  computeScheduledOccurrences,
  walkMonthlySchedule,
  materializeDueBudgetItems,
  materializeDueTemplateFills,
  templateFillKey,
  templateFillSourceId,
  computeTemplateSourceDraws,
  forecastScheduledTransactions,
  forecastTemplateFills,
  forecastAllFills,
  forecastPlannedExpenses,
  forecastDueAheadTransactions,
  forecastDueAheadTemplateFills,
  resolveSetSourceLegs,
  resolvePendingSetRow,
  forecastKey,
  fillDisplayTotal,
  fillSetLineCount,
  computeEnvelopeUpcomingDeltas,
} from './engine/scheduling.js';

// Single-envelope 12-month projection and its recommendation rules.
export {
  projectEnvelopeBalance,
  recommendEnvelopeActions,
  envelopeFloor,
  computeSpareByEnvelope,
  findUnlinkedScheduledPayments,
  settles as paymentSettles,
  netForecastAgainstRealPayments,
} from './engine/envelope-forecast.js';

// Historical balance series, Age-of-Money, Money Cushion.
export {
  computeEnvelopeBalanceHistory,
  computeEnvelopeBalanceHistoryByEnvelope,
  computeAgeOfMoney,
  computeAgeOfMoneyDetailed,
  computeAgeOfMoneyHistory,
  AOM_HEALTH_GREEN,
  AOM_HEALTH_YELLOW,
  AOM_HEALTHY_RUNWAY_DAYS,
  AOM_ONE_OFF_FACTOR,
  aomOneOffIncomes,
  aomPoolTransactions,
  attributeAgeOfMoneyDrop,
  computeMoneyCushion,
} from './engine/history.js';

// Dashboard summary, credit-card payment due, schema invariants.
export {
  computeDashboardSummary,
  computeCreditCardPaymentDue,
  validateTxSplits,
  findInvalidTxSplits,
  validateAccountRefs,
  validateEnvelopeRefs,
  validateAmountSign,
  validateTxDate,
  validateSelfTransfer,
  validateTxType,
  validateFromBudgetLink,
  repointFromBudgetMonth,
  runInvariantCheck,
  futureRowsTouching,
  findFutureRowsOnArchived,
} from './engine/insights.js';

// A loan given's interest cycle.
export { loanGivenTerms, loanRateOn, loanRates, loanInstalment, loanMethod, LOAN_METHODS } from './engine/loan-terms.js';

// A loan's repayment schedule (its plan item's payments to zero).
export { loanSchedule, loanRepayment, loanBalancePath, loanPlanUpdates, LOAN_SCHEDULE_MAX_YEARS } from './engine/loan-schedule.js';

// Plan-item start/end month and the dated plan view ("a year" = the coming 12 months).
export {
  itemStartMonth, itemEndMonth, itemDateBounds, itemDateStatus, monthStartDate, planItemsAsOf,
} from './engine/item-dates.js';

// Realised gains for the tax return: FIFO lots and the deemed cost.
export { computeRealizedSales, summarizeTaxYear } from './engine/tax-lots.js';

// Bank reconciliation: which rows it vouches for, and drift since.
export {
  isReconciledRow,
  reconciledLedgerBalance,
  reconciledBalanceShift,
  findReconciledDrift,
} from './engine/reconciled.js';

// Date-range aggregations for the reports page.
export {
  aggregateSpendingByEnvelope,
  aggregatePayeeSpending,
  aggregateIncomeVsSpending,
  aggregateSpendingByMonth,
  aggregateSavingByMonth,
  aggregateEnvelopeBalances,
  aggregateBudgetAllocation,
  trailingWindowStart,
  trailingMonthlyAverage,
  txPayeeLabel,
} from './engine/reports.js';

// Money flow (Sankey) data for the plan and the actuals.
export { buildPlanFlow, buildActualFlow } from './engine/flows.js';
