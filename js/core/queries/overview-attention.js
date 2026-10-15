import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { isoDate } from '../context.js';
import { projection, envelopeResult, goalResult, cashOutlook } from '../affordability-outlook.js';
import { cardFundingFor } from '../../engine/card-settlement.js';
import { round2 } from '../../utils.js';

export default {
  name: 'overview.attention',
  summary: 'Read-only, date-ordered cash shortfalls, envelope reserve gaps and savings goal risks over twelve months. Uses the same daily forecasts as purchase.preview; independent of the selected balance lens. Includes incomplete goal and card repayment coverage.',
  input: { type: 'object', properties: { date: { type: 'date', description: 'Forecast start (default today)' } } },
  run(data, input, ctx) {
    const today = refDate(input, ctx);
    const start = isoDate(today);
    const clock = { ...ctx, today, now: today, todayIso: start };
    const anniversaryDay = Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth() + 13, 0).getDate());
    let end = isoDate(new Date(today.getFullYear(), today.getMonth() + 12, anniversaryDay - 1));
    const items = [];
    const incomplete = [];
    for (const env of (data.envelopes || []).filter(e => !e.archived)) {
      const p = projection(data, env.id, clock);
      if (p.unresolved || !p.low || !p.daily.length) {
        incomplete.push({ kind: 'envelope', id: env.id, name: env.name });
        continue;
      }
      end = p.daily.at(-1)?.date ?? end;
      const result = envelopeResult(data, env, p);
      const first = p.daily.find(d => d.balance < result.floor - 0.005);
      if (first) items.push({ key: `envelope:${env.id}`, kind: 'envelope', id: env.id, name: env.name,
        date: first.date, balance: round2(first.balance), floor: result.floor,
        gap: round2(-result.spare), low: result.low });
      if (Number(env.goal_amount) > 0) {
        // Overdue goals still require attention when today's balance misses
        // the target. Do not silently classify them as future/out-of-window.
        const overdue = !!env.goal_date && env.goal_date < start;
        const goal = goalResult(overdue ? { ...env, goal_date: start } : env, p, start);
        if (goal.status === 'outside') incomplete.push({ kind: 'goal', id: env.id, name: env.name, date: goal.date });
        else if (goal.status === 'short') items.push({ key: `goal:${env.id}`, kind: 'goal', id: env.id, name: env.name,
          date: goal.date, deadline: env.goal_date || null, overdue, target: goal.target,
          projected: goal.projected, gap: goal.gap });
      }
    }
    for (const account of cashOutlook(data, end, clock)) {
      if (account.firstNegative) items.push({ key: `account:${account.id}`, kind: 'account', id: account.id,
        name: account.name, date: account.firstNegative.date, balance: account.firstNegative.balance, low: account.low, ...(account.estimated ? { estimated: true } : {}) });
    }
    for (const a of (data.accounts || []).filter(a => !a.archived && a.type === 'credit_card')) {
      if (!cardFundingFor(a, data.accounts)) incomplete.push({ kind: 'card', id: a.id, name: a.name });
    }
    const priority = { account: 0, envelope: 1, goal: 2 };
    items.sort((a, b) => a.date.localeCompare(b.date) || priority[a.kind] - priority[b.kind] || a.key.localeCompare(b.key));
    return ok({ start, end, items, incomplete });
  },
};
