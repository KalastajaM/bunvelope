// Shared twelve-month outlook for purchase previews and Overview attention.
import { monthCountry, monthTombstones } from './month-fields.js';
import { projectEnvelopeBalance, envelopeFloor } from '../engine/envelope-forecast.js';
import { simulate } from '../engine/simulation.js';
import { computeAccountBalancesAtDates, applyAccountEffects, isSpendingAccount } from '../engine/balances.js';
import { lensTransactions } from '../engine/lens.js';
import { cardFundingFor } from '../engine/card-settlement.js';
import { toCents, fromCents } from '../engine/_constants.js';
import { round2 } from '../utils.js';

export function projection(data, id, ctx) {
  return projectEnvelopeBalance({ envelopeId: id, transactions: data.transactions || [],
    accounts: data.accounts || [], envelopes: data.envelopes || [],
    budgetItems: data.budgetItems || [], envelopeTemplates: data.envelopeTemplates || [],
    today: ctx.today, months: 12, country: monthCountry(data), tombstones: monthTombstones(data) });
}

export function envelopeResult(data, env, p) {
  const floor = envelopeFloor(data.budgetItems || [], env.id);
  return { spare: round2(p.low.balance - floor), low: { date: p.low.date, balance: round2(p.low.balance) }, floor: round2(floor) };
}

export function goalResult(env, p, today) {
  const target = Number(env.goal_amount);
  const end = p.daily.at(-1).date;
  const date = env.goal_date || end;
  if (date < today || date > end) return { status: 'outside', date, target, projected: null };
  const point = p.daily.findLast(d => d.date <= date);
  if (!point) return { status: 'outside', date, target, projected: null };
  return { status: point.balance >= target - 0.005 ? 'onTrack' : 'short', date, target,
    projected: round2(point.balance), gap: round2(Math.max(0, target - point.balance)), hasDeadline: !!env.goal_date };
}

// Use simulation rows (including interest and card settlements) and the shared
// cents-based balance walk at every event date. Month-end samples miss dips.
export function cashOutlook(data, end, ctx, recordedData = data) {
  const sim = simulate({ source: data, today: ctx.today, months: 12, trackAlerts: false });
  // Follow uncertain spending through repayments/transfers too: an estimate
  // on a card can drive a cash shortfall in its funding account.
  const estimatedSince = new Map();
  for (const row of sim.rows) {
    const estimate = row.forecast_estimate;
    if (estimate && (estimate.accountSource !== 'explicit' || estimate.timing !== 'dated')) {
      if (!estimatedSince.has(row.account)) estimatedSince.set(row.account, row.date);
    }
    if (row.type === 'account_transfer' && (estimatedSince.has(row.from_account) || estimatedSince.has(row.to_account))) {
      if (!estimatedSince.has(row.from_account)) estimatedSince.set(row.from_account, row.date);
      if (!estimatedSince.has(row.to_account)) estimatedSince.set(row.to_account, row.date);
    }
  }
  const dates = [...new Set([ctx.todayIso, end, ...sim.rows.map(t => t.date)
    .filter(d => typeof d === 'string' && d >= ctx.todayIso && d <= end)])].sort();
  const balances = computeAccountBalancesAtDates(data.accounts, sim.rows, { dates });
  const recordedRows = lensTransactions(recordedData, { lens: 'today', today: ctx.today });
  const current = computeAccountBalancesAtDates(recordedData.accounts, recordedRows, { dates: [ctx.todayIso] })[0];
  const watched = data.accounts.filter(a => !a.archived && (isSpendingAccount(a) || a.type === 'savings')
    && a.type !== 'credit_card' && !cardFundingFor(a, data.accounts));
  return watched.map(account => {
    let low = { date: dates[0], balance: Infinity };
    /** @type {{date: string, balance: number} | null} */
    let firstNegative = null;
    dates.forEach((date, i) => {
      const balance = balances[i].get(account.id) ?? 0;
      if (balance < low.balance) low = { date, balance: round2(balance) };
      if (!firstNegative && balance < -0.005) firstNegative = { date, balance: round2(balance) };
    });
    const today = round2(current.get(account.id) ?? 0);
    const cents = { income: 0, spending: 0, transfers: 0, repayments: 0, other: 0 };
    const addRow = (row, sign) => {
      const kind = row.type === 'income' ? 'income' : row.type === 'expense' ? 'spending'
        : row.type === 'debt_payment' || row.forecast_kind === 'card-settlement'
          || (row.type === 'account_transfer' && data.accounts.some(a => a.id === row.to_account && a.type === 'credit_card')) ? 'repayments'
          : ['account_transfer', 'investment_transfer'].includes(row.type) ? 'transfers' : 'other';
      applyAccountEffects(row, (id, delta) => { if (id === account.id) cents[kind] += sign * toCents(delta); });
    };
    // Subtract already-posted activity, then add the forecast through its low.
    // This also explains pending/overdue rows and netting changes on today's date.
    for (const row of recordedRows) addRow(row, -1);
    for (const row of sim.rows) if (!row.date || row.date.slice(0, 10) <= low.date) addRow(row, 1);
    const movements = Object.fromEntries(Object.entries(cents).map(([kind, amount]) => [kind, fromCents(amount)]));
    // Keep the bridge in core: the UI must not derive money. This includes
    // pending rows and generated plan/settlement rows through the low date.
    return { id: account.id, name: account.name, current: today,
      changeToLow: round2(low.balance - today), movements, low, firstNegative,
      estimated: !!firstNegative && estimatedSince.has(account.id) && estimatedSince.get(account.id) <= (/** @type {{date: string}} */ (firstNegative)).date };
  });
}

