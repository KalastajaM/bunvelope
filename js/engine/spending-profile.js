// Expected account mix and timing for unscheduled planned spending.
// These are projections only: never materialise these rows into the ledger.
import { requireClock, toCents, fromCents } from './_constants.js';
import { txAbsAmount, isPostedTx } from './tx-amounts.js';
import { txSpendPairs } from './balances.js';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const spendingAccount = a => a && !a.archived && ['bank', 'checking', 'cash', 'credit_card', 'savings'].includes(a.type);

// Largest remainder allocation, stable in account order, preserves every cent.
export function allocateCents(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map(w => total * w / sum);
  const parts = exact.map(Math.floor);
  const order = exact.map((n, i) => ({ i, rest: n - parts[i] })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let n = total - parts.reduce((a, b) => a + b, 0), i = 0; i < n; i++) parts[order[i].i]++;
  return parts;
}

/** Six calendar months including the current month, through the injected day.
 * Weight 6 for this month down to 1 for the oldest. Only posted purchases,
 * with split expenses attributed by their envelope amounts.
 * @param {{transactions?: any[], accounts?: any[], envelopes?: any[]}} source
 * @param {Date} today
 */
export function spendingProfiles({ transactions = [], accounts = [], envelopes = [] }, today) {
  requireClock(today, 'spendingProfiles');
  const end = ymd(today);
  const start = ymd(new Date(today.getFullYear(), today.getMonth() - 5, 1));
  const live = accounts.filter(spendingAccount);
  const ids = new Set(live.map(a => a.id));
  const buckets = new Map();
  const bucket = id => {
    if (!buckets.has(id)) buckets.set(id, { amounts: new Map(), months: new Map(), count: 0 });
    return buckets.get(id);
  };
  const add = (id, account, amount, age) => {
    if (amount <= 0) return;
    const b = bucket(id); b.count++;
    b.amounts.set(account, (b.amounts.get(account) || 0) + amount * (6 - age));
    if (!b.months.has(age)) b.months.set(age, new Map());
    const m = b.months.get(age); m.set(account, (m.get(account) || 0) + amount);
  };
  for (const tx of transactions) {
    if (tx.type !== 'expense' || !isPostedTx(tx) || !ids.has(tx.account) || !tx.date || tx.date < start || tx.date.slice(0, 10) > end) continue;
    const age = (today.getFullYear() - Number(tx.date.slice(0, 4))) * 12 + today.getMonth() + 1 - Number(tx.date.slice(5, 7));
    if (age < 0 || age > 5) continue;
    add(null, tx.account, txAbsAmount(tx), age);
    for (const [id, amount] of txSpendPairs(tx)) add(id, tx.account, amount, age);
  }
  const make = env => {
    const own = buckets.get(env?.id);
    const b = own || buckets.get(null);
    const override = (env?.forecast_account_shares || []).filter(s => ids.has(s.account_id) && s.percent > 0);
    const source = override.length ? 'override' : own ? 'history' : b ? 'household' : 'fallback';
    const weights = live.map(a => override.length ? override.find(s => s.account_id === a.id)?.percent || 0
      : b?.amounts.get(a.id) || (!b && a === live[0] ? 1 : 0));
    const points = allocateCents(10000, weights);
    let confidence = source === 'override' && override.length === env?.forecast_account_shares?.length ? 'override' : 'limited';
    if (source === 'history' && b.count >= 12 && b.months.size >= 3) {
      const variable = [...b.months.values()].some(m => {
        const total = [...m.values()].reduce((a, v) => a + v, 0);
        return live.reduce((sum, a, i) => sum + Math.abs((m.get(a.id) || 0) / total - points[i] / 10000), 0) > 0.5;
      });
      confidence = variable ? 'variable' : 'established';
    }
    return { envelopeId: env?.id ?? null, source, confidence, sampleCount: own?.count || 0,
      months: own?.months.size || 0, start, end,
      shares: live.flatMap((a, i) => points[i] ? [{ accountId: a.id, name: a.name || a.id, percent: points[i] / 100 }] : []) };
  };
  return { byEnvelope: new Map(envelopes.map(e => [e.id, make(e)])), fallback: make(null) };
}

/** Expand AFTER monthly netting and occurrence deduplication. Splitting before
 * either step would settle an occurrence repeatedly or drop all but one slice.
 * horizon only truncates the result; it never changes the allocation.
 * @param {any[]} rows
 * @param {{today: Date, end: string, profiles?: ReturnType<typeof spendingProfiles> | null}} options
 */
export function projectPlannedSpending(rows, { today, end, profiles = null }) {
  requireClock(today, 'projectPlannedSpending');
  const tomorrow = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  return rows.flatMap(row => {
    if (!row.is_planned) return [row];
    const p = profiles?.byEnvelope.get(row.envelope_id) || profiles?.fallback;
    const shares = row.account ? [{ accountId: row.account, percent: 100 }] : (p?.shares.length ? p.shares : [{ accountId: null, percent: 100 }]);
    const source = row.account ? 'explicit' : p?.source || 'unassigned';
    const confidence = row.account ? 'explicit' : p?.confidence || 'limited';
    const monthly = allocateCents(toCents(txAbsAmount(row)), shares.map(s => s.percent));
    const dates = [];
    if (row.forecast_spread) {
      const month = row.forecast_month_key;
      const [year, mon] = month.split('-').map(Number);
      const last = new Date(year, mon, 0).getDate();
      for (let day = 1; day <= last; day++) {
        const date = ymd(new Date(year, mon - 1, day));
        if (date >= tomorrow && (!row.forecast_spread_since || date >= row.forecast_spread_since)
          && (!row.forecast_spread_until || date <= row.forecast_spread_until)) dates.push(date);
      }
    } else dates.push(row.date);
    if (!dates.length) return [];
    const total = monthly.reduce((sum, cents) => sum + cents, 0);
    const remaining = [...monthly];
    return dates.flatMap((date, j) => {
      // The envelope and account walks must see the SAME daily total, even
      // for tiny amounts. Allocate that day's cents against the remaining
      // account budgets; each day's total and each account's monthly total
      // are both conserved. Compute beyond the horizon too for stability.
      const daily = Math.round(total * (j + 1) / dates.length) - Math.round(total * j / dates.length);
      const parts = allocateCents(daily, remaining);
      return shares.flatMap((share, i) => {
        remaining[i] -= parts[i];
        if (!parts[i] || date > end) return [];
        return [{ ...row, id: `${row.id}:${share.accountId || 'unassigned'}:${date}`, date,
          account: share.accountId, amount: fromCents(parts[i]),
          forecast_estimate: { accountSource: source, confidence, timing: row.forecast_spread ? 'daily' : row.forecast_undated ? 'month-end' : 'dated' } }];
      });
    });
  });
}
