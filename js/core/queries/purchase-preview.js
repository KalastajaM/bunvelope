// Read-only purchase and optional funding move, using the same recorded rows
// and projections as the real save. No ambient clock, ids or state writes.
import { ok, fail } from '../result.js';
import { buildRecordedRow } from '../tx-record.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';
import { isoDate } from '../context.js';
import { envelopeFloor } from '../../engine/envelope-forecast.js';
import { isSpendingAccount } from '../../engine/balances.js';
import { cardFundingFor } from '../../engine/card-settlement.js';
import { round2 } from '../../utils.js';
import { projection, envelopeResult, goalResult, cashOutlook } from '../affordability-outlook.js';

const bad = (path, message) => fail('bad_input', { errors: [{ path, message }] });
const active = (rows, id) => (rows || []).find(r => r.id === id && !r.archived);

export default {
  name: 'purchase.preview',
  summary: 'Read-only affordability check for a purchase within the next 12 months. Compares projected envelope spare, daily account shortfalls (including savings and configured card repayments), and all active savings goals. Returns proposed transaction.record steps for an explicit atomic save. An optional fundingEnvelope/fundingAmount previews a same-date envelope move. Existing plan spending is netted by the shared forecasts. No money or records are changed.',
  input: { type: 'object', required: ['amount', 'date', 'account', 'envelope'], properties: {
    amount: TX_INPUT_PROPERTIES.amount,
    date: TX_INPUT_PROPERTIES.date,
    account: { type: 'ref', kind: 'account' },
    envelope: { type: 'ref', kind: 'envelope' },
    payee: { type: 'string' },
    fundingEnvelope: { type: 'ref', kind: 'envelope', description: 'Optional envelope to move funds from on the purchase date' },
    fundingAmount: { type: 'money', minimum: 0.01, description: 'Amount to move; required with fundingEnvelope' },
  } },
  run(data, input, ctx) {
    const account = active(data.accounts, input.account);
    const env = active(data.envelopes, input.envelope);
    if (!account || !(isSpendingAccount(account) || account.type === 'savings' || account.type === 'credit_card')) return bad('account', 'Choose an active spending, savings or credit-card account.');
    if (!env) return bad('envelope', 'Choose an active envelope.');
    if (input.date < ctx.todayIso) return bad('date', 'Purchase date must be today or later.');
    const beforeProjection = projection(data, env.id, ctx);
    if (beforeProjection.unresolved || !beforeProjection.low) return bad('envelope', 'Envelope cannot be projected.');
    const end = beforeProjection.daily.at(-1)?.date;
    if (!end) return bad('envelope', 'Envelope cannot be projected.');
    if (input.date > end) return bad('date', `Purchase date must be on or before ${end}.`);
    if ((input.fundingEnvelope !== undefined) !== (input.fundingAmount !== undefined)) return bad('fundingEnvelope', 'Provide both a source envelope and funding amount.');
    if (input.fundingEnvelope !== undefined && (!active(data.envelopes, input.fundingEnvelope) || input.fundingEnvelope === env.id)) return bad('fundingEnvelope', 'Choose a different active envelope.');

    const scheduled = input.date > ctx.todayIso;
    const steps = [];
    if (input.fundingEnvelope) steps.push({ name: 'transaction.record', input: {
      type: 'envelope_transfer', amount: input.fundingAmount, fromEnvelope: input.fundingEnvelope,
      toEnvelope: env.id, date: input.date, scheduled,
    } });
    steps.push({ name: 'transaction.record', input: { type: 'expense', amount: input.amount,
      date: input.date, account: account.id, envelope: env.id, payee: input.payee || '', scheduled } });
    const ids = new Set((data.transactions || []).map(t => t.id));
    let sequence = 0;
    const previewCtx = { ...ctx, newId: () => {
      let id;
      do { id = `purchase-preview:${++sequence}`; } while (ids.has(id));
      ids.add(id); return id;
    } };
    let after = data;
    for (const step of steps) {
      const row = buildRecordedRow(step.input, previewCtx, after);
      if (!row.ok) return row;
      after = { ...after, transactions: [...after.transactions, row.value] };
    }
    const beforeMap = new Map([[env.id, beforeProjection]]);
    const afterMap = new Map();
    const project = (source, map, id) => {
      if (!map.has(id)) map.set(id, projection(source, id, ctx));
      return map.get(id);
    };
    const afterProjection = project(after, afterMap, env.id);
    const envelope = { id: env.id, name: env.name,
      before: envelopeResult(data, env, beforeProjection), after: envelopeResult(after, env, afterProjection) };
    const beforeCash = cashOutlook(data, end, ctx);
    const accounts = cashOutlook(after, end, ctx, data).map(a => {
      const before = beforeCash.find(b => b.id === a.id);
      const worsened = !!a.firstNegative && (!before.firstNegative
        || a.firstNegative.date < before.firstNegative.date || a.low.balance < before.low.balance - 0.005);
      return { id: a.id, name: a.name, current: before.current,
        changeToLow: a.changeToLow, movements: a.movements,
        lowDifference: round2(a.low.balance - before.low.balance),
        before: { low: before.low, firstNegative: before.firstNegative },
        after: { low: a.low, firstNegative: a.firstNegative }, impact: !a.firstNegative ? 'clear' : !before.firstNegative ? 'new' : worsened ? 'worse' : 'existing' };
    });
    const goals = data.envelopes.filter(e => !e.archived && Number(e.goal_amount) > 0).map(e => ({
      id: e.id, name: e.name,
      before: goalResult(e, project(data, beforeMap, e.id), ctx.todayIso),
      after: goalResult(e, project(after, afterMap, e.id), ctx.todayIso),
    }));
    const funding = input.fundingEnvelope ? (() => {
      const donor = active(data.envelopes, input.fundingEnvelope);
      return { id: donor.id, name: donor.name, amount: input.fundingAmount,
        before: envelopeResult(data, donor, project(data, beforeMap, donor.id)),
        after: envelopeResult(after, donor, project(after, afterMap, donor.id)) };
    })() : null;
    // A set-mode refill can keep the selected envelope healthy by draining a
    // different source later. Surface newly created or worsened shortfalls
    // anywhere in that chain, even when no manual funding move was selected.
    const otherEnvelopes = data.envelopes.filter(e => !e.archived && e.id !== env.id && e.id !== input.fundingEnvelope).flatMap(e => {
      const before = envelopeResult(data, e, project(data, beforeMap, e.id));
      const next = envelopeResult(after, e, project(after, afterMap, e.id));
      const worsened = next.spare < -0.005 && (next.spare < before.spare - 0.005 || next.low.date < before.low.date);
      return worsened ? [{ id: e.id, name: e.name, before, after: next, impact: before.spare < -0.005 ? 'worse' : 'new' }] : [];
    });
    // Suggestions are candidates, not promises. Selecting one reruns both
    // projections; set-mode fills and source chains can make effects non-linear.
    const gap = round2(Math.max(0, -envelope.after.spare));
    const suggestions = !funding && gap > 0 ? data.envelopes.filter(e => !e.archived && e.id !== env.id).flatMap(donor => {
      const p = project(after, afterMap, donor.id);
      if (p.unresolved || !p.low) return [];
      let available = p.low.balance - envelopeFloor(data.budgetItems || [], donor.id);
      if (Number(donor.goal_amount) > 0) {
        const goal = goalResult(donor, p, ctx.todayIso);
        if (goal.status !== 'onTrack' || goal.projected === null) return [];
        available = Math.min(available, goal.projected - goal.target);
      }
      const amount = round2(Math.min(gap, available));
      return amount >= 0.01 ? [{ id: donor.id, name: donor.name, amount }] : [];
    }).sort((a, b) => b.amount - a.amount) : [];
    const repaymentUnknown = account.type === 'credit_card' && !cardFundingFor(account, data.accounts);
    const [purchaseYear, purchaseMonth] = input.date.split('-').map(Number);
    const repaymentBeyondWindow = account.type === 'credit_card'
      && isoDate(new Date(purchaseYear, purchaseMonth, 15)) > end;
    const unknownGoals = goals.some(g => g.after.status === 'outside');
    const needsAttention = envelope.after.spare < -0.005 || (funding && funding.after.spare < -0.005)
      || otherEnvelopes.length > 0 || accounts.some(a => a.after.firstNegative) || goals.some(g => g.after.status === 'short');
    const purchaseProblem = envelope.after.spare < -0.005 || (funding && funding.after.spare < -0.005)
      || otherEnvelopes.length > 0 || accounts.some(a => a.impact === 'new' || a.impact === 'worse')
      || goals.some(g => g.after.status === 'short' && (g.before.status !== 'short' || g.after.gap > g.before.gap));
    const incomplete = repaymentUnknown || repaymentBeyondWindow || unknownGoals;
    const assessment = purchaseProblem ? 'attention' : incomplete ? 'incomplete' : needsAttention ? 'existing' : 'covered';
    return ok({ assessment, start: ctx.todayIso, end, date: input.date, amount: input.amount,
      account: { id: account.id, name: account.name }, envelope, otherEnvelopes, accounts, goals, funding, suggestions, steps,
      repaymentUnknown, repaymentBeyondWindow,
      status: needsAttention ? 'attention' : repaymentUnknown || repaymentBeyondWindow || unknownGoals ? 'incomplete' : 'covered' });
  },
};
