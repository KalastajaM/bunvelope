import { isPostedTx, txAbsAmount } from '../engine/tx-amounts.js';
import { round2 } from '../utils.js';

// Calendar arithmetic deliberately uses date-only UTC values, independent of DST.
export function shiftRecurringDate(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, end))).toISOString().slice(0, 10);
}
const day = date => Date.parse(date + 'T00:00:00Z') / 86400000;
export function discoverRecurring(data, today, includeTracked = false) {
  const canonical = value => {
    let key = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const seen = new Set();
    while (data.meta?.payeeAliases?.[key] && !seen.has(key)) {
      seen.add(key); key = String(data.meta.payeeAliases[key]).trim().toLowerCase().replace(/\s+/g, ' ');
    }
    return key;
  };
  const groups = new Map();
  const schedules = (data.budgetItems || []).filter(it => it.as_schedule && (it.kind || 'expense') === 'expense');
  const scheduleById = new Map(schedules.map(it => [it.id, it]));
  const knownPayees = new Map();
  const remember = (payee, item) => {
    const key = JSON.stringify([canonical(payee), item.account_id]);
    if (!knownPayees.has(key)) knownPayees.set(key, new Set());
    knownPayees.get(key).add(item.id);
  };
  for (const item of schedules) remember(item.description, item);
  for (const tx of data.transactions || []) {
    if (typeof tx.from_budget !== 'string') continue;
    const item = scheduleById.get(tx.from_budget.slice(0, tx.from_budget.lastIndexOf(':')));
    if (item && tx.payee) remember(tx.payee, item);
  }
  const activeAccounts = new Set((data.accounts || []).filter(a => !a.archived).map(a => a.id));
  const from = shiftRecurringDate(today, -36);
  for (const tx of data.transactions || []) {
    if (tx.type !== 'expense' || !isPostedTx(tx) || (!includeTracked && tx.from_budget) || tx.reverses || tx.reversed_by || tx.date < from || tx.date > today || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date || '') || !txAbsAmount(tx)) continue;
    const payee = canonical(tx.payee);
    if (!payee || !activeAccounts.has(tx.account)) continue;
    const key = JSON.stringify([payee, tx.account]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }
  const suggestions = [];
  for (const [groupKey, history] of groups) {
    history.sort((a, b) => a.date.localeCompare(b.date));
    const seen = new Set();
    const rows = history.filter(tx => {
      const fingerprint = JSON.stringify([tx.date, txAbsAmount(tx)]);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint); return true;
    });
    const last = rows.at(-1);
    for (const period of [1, 3, 12]) {
      const evidence = [last];
      for (let i = rows.length - 2; i >= 0; i--) {
        const next = evidence[0];
        if (Math.abs(day(shiftRecurringDate(rows[i].date, period)) - day(next.date)) > 7) break;
        evidence.unshift(rows[i]);
      }
      if (evidence.length < (period === 12 ? 2 : 3)) continue;
      const amounts = evidence.slice(-12).map(txAbsAmount);
      const increase = priceStep(amounts);
      const variable = !increase && amounts.some(amount => Math.abs(amount / txAbsAmount(last) - 1) > 0.15);
      // Variable spending needs an additional cycle; cadence alone is weaker evidence.
      if (variable && evidence.length < (period === 12 ? 3 : 4)) continue;
      const expected = shiftRecurringDate(last.date, period);
      if (day(today) - day(expected) > 45) continue;
      const [payeeKey, accountId] = JSON.parse(groupKey);
      const key = JSON.stringify([payeeKey, accountId, period]);
      const decision = data.meta?.recurringSuggestions?.[key];
      const linked = decision?.itemId && schedules.some(it => it.id === decision.itemId);
      const tracked = knownPayees.has(groupKey);
      if (!includeTracked && tracked && !linked) continue;
      let firstDate = expected;
      for (let n = 2; firstDate <= today; n++) firstDate = shiftRecurringDate(last.date, period * n);
      const amount = variable ? round2(amounts.reduce((sum, value) => sum + value, 0) / amounts.length) : txAbsAmount(last);
      const matchedIds = new Set(knownPayees.get(groupKey) || []);
      if (linked) matchedIds.add(decision.itemId);
      const matched = [...matchedIds].map(id => scheduleById.get(id)).filter(Boolean);
      if (includeTracked && matched.some(it => it.recurring_review?.hidden || it.include === false)) continue;
      suggestions.push({ key, payee: last.payee, accountId, envelopeId: last.envelope_id || null, period, amount, variable, minAmount: Math.min(...amounts), maxAmount: Math.max(...amounts), latestAmount: txAbsAmount(last), increase, trackedItemId: matched.length === 1 ? matched[0].id : null,
        annual: round2(amount * 12 / period), monthly: round2(amount / period), firstDate,
        status: linked ? 'linked' : decision?.dismissed ? 'dismissed' : 'pending', itemId: linked ? decision.itemId : null,
        evidence: evidence.slice(-12).map(tx => ({ id: tx.id, date: tx.date, amount: txAbsAmount(tx) })), count: evidence.length });
      break;
    }
  }
  return suggestions.sort((a, b) => b.annual - a.annual);
}

// A higher payment after at least two stable payments. Variable usage is not a
// confirmed price change: the UI always asks the user to review the evidence.
function priceStep(amounts) {
  if (amounts.length < 3) return null;
  const latest = amounts.at(-1);
  let index = amounts.length - 1;
  while (index > 0 && Math.abs(amounts[index - 1] / latest - 1) <= 0.02) index--;
  const prior = amounts.slice(0, index);
  if (prior.length < 2) return null;
  const baseline = prior.at(-1);
  let stable = 0;
  for (let i = prior.length - 1; i >= 0 && Math.abs(prior[i] / baseline - 1) <= 0.02; i--) stable++;
  if (stable < 2 || latest < baseline * 1.05 || latest - baseline < 0.5) return null;
  return { previous: baseline, current: latest, index };
}
export function recurringPriceIncreases(data, today) {
  return discoverRecurring(data, today, true).flatMap(s => {
    if (!s.increase) return [];
    const last = s.evidence[s.increase.index];
    const key = JSON.stringify([s.key, last.date, last.amount]);
    return [{ ...s, key, extraAnnual: round2((s.increase.current - s.increase.previous) * 12 / s.period),
      dismissed: data.meta?.recurringPriceReviews?.[key] === true }];
  });
}
