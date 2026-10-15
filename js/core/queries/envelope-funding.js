import { ok, fail } from '../result.js';
import { buildRecordedRow } from '../tx-record.js';
import { projection, envelopeResult, goalResult } from '../affordability-outlook.js';
import { round2 } from '../../utils.js';

const bad = message => fail('bad_input', { errors: [{ path: 'source', message }] });

export default {
  name: 'envelope.funding',
  summary: 'Read-only candidates for funding an envelope reserve gap today. Optional source or sources previews their combined transfers against all active envelopes and savings goals. Returns transaction.record steps only when the gap improves without new or worsened shortfalls. No cash moves between accounts.',
  input: { type: 'object', required: ['envelope'], properties: {
    envelope: { type: 'ref', kind: 'envelope' },
    sources: { type: 'array', items: { type: 'ref', kind: 'envelope' }, description: 'Candidates to preview together; splits funding proportionally to eligible spare, capped at the gap. Use instead of source.' },
    source: { type: 'ref', kind: 'envelope', description: 'Optional candidate to preview; the amount is limited by its spare and goal surplus' },
  } },
  run(data, input, ctx) {
    const active = (data.envelopes || []).filter(e => !e.archived);
    const target = active.find(e => e.id === input.envelope);
    if (!target) return bad('Choose an active target envelope.');
    const before = new Map(active.map(e => [e.id, projection(data, e.id, ctx)]));
    const p = before.get(target.id);
    if (!p || p.unresolved || !p.low) return bad('Target forecast is unavailable.');
    const envelope = { id: target.id, name: target.name, ...envelopeResult(data, target, p) };
    const gap = round2(Math.max(0, -envelope.spare));
    const candidates = active.filter(e => e.id !== target.id).flatMap(e => {
      const outlook = before.get(e.id);
      if (!outlook || outlook.unresolved || !outlook.low) return [];
      let available = envelopeResult(data, e, outlook).spare;
      if (Number(e.goal_amount) > 0) {
        const goal = goalResult(e, outlook, ctx.todayIso);
        if (goal.status !== 'onTrack' || goal.projected === null) return [];
        available = Math.min(available, goal.projected - goal.target);
      }
      const amount = round2(Math.min(gap, available));
      return amount >= 0.01 ? [{ id: e.id, name: e.name, amount, available: round2(available) }] : [];
    }).sort((a, b) => b.available - a.available || a.id.localeCompare(b.id));
    const base = { date: ctx.todayIso, end: p.daily.at(-1)?.date, envelope, gap, candidates };
    if (input.source !== undefined && input.sources !== undefined) return bad('Choose source or sources, not both.');
    if (input.source === undefined && input.sources === undefined) return ok({ ...base, preview: null });
    const selected = input.sources ?? [input.source];
    if (!selected.length || new Set(selected).size !== selected.length) return bad('Choose at least one distinct source.');
    if (selected.some(id => !candidates.some(c => c.id === id))) return bad('A source no longer has eligible spare money. Refresh the suggestions.');
    // Canonical ordering and largest remainders make the split independent of click
    // order, cent-exact, and bounded by each source's eligible spare.
    const chosen = candidates.filter(c => selected.includes(c.id));
    const availableCents = chosen.map(c => Math.round(c.available * 100));
    const totalCents = availableCents.reduce((sum, n) => sum + n, 0);
    const neededCents = Math.min(Math.round(gap * 100), totalCents);
    const shares = availableCents.map(n => neededCents * n / totalCents);
    const cents = shares.map(Math.floor);
    const order = shares.map((n, i) => ({ i, remainder: n - cents[i] }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
    const left = neededCents - cents.reduce((sum, n) => sum + n, 0);
    for (let i = 0; i < left; i++) cents[order[i].i]++;
    const sources = chosen.map((c, i) => ({ ...c, amount: cents[i] / 100 }));
    const steps = sources.filter(c => c.amount > 0).map(source => ({ name: 'transaction.record', input: {
      type: 'envelope_transfer', date: ctx.todayIso, fromEnvelope: source.id, toEnvelope: target.id, amount: source.amount,
    } }));
    const ids = new Set((data.transactions || []).map(t => t.id));
    const rows = [];
    for (const step of steps) {
      let id = 'funding-preview';
      while (ids.has(id)) id += ':';
      ids.add(id);
      const row = buildRecordedRow(step.input, { ...ctx, newId: () => id }, data);
      if (!row.ok) return row;
      rows.push(row.value);
    }
    const after = { ...data, transactions: [...data.transactions, ...rows] };
    const changes = [], goals = [], blockers = [];
    let remainingGap = gap;
    for (const env of active) {
      const previous = before.get(env.id);
      const next = projection(after, env.id, ctx);
      if (!previous || previous.unresolved || next.unresolved || !previous.low || !next.low) {
        blockers.push({ kind: 'unavailable', id: env.id, name: env.name });
        continue;
      }
      const first = envelopeResult(data, env, previous);
      const last = envelopeResult(after, env, next);
      if (env.id === target.id) remainingGap = round2(Math.max(0, -last.spare));
      // Compare every day: unchanged minima can hide an earlier/worse dip.
      const dailyWorse = next.daily.some((point, i) => point.balance < last.floor - 0.005
        && point.balance < (previous.daily[i]?.balance ?? Infinity) - 0.005);
      if (dailyWorse) blockers.push({ kind: 'reserve', id: env.id, name: env.name });
      const changed = next.daily.some((point, i) => Math.abs(point.balance - (previous.daily[i]?.balance ?? Infinity)) > 0.005);
      if (changed || env.id === target.id || selected.includes(env.id)) changes.push({ id: env.id, name: env.name, before: first, after: last });
      if (Number(env.goal_amount) > 0) {
        const b = goalResult(env, previous, ctx.todayIso), a = goalResult(env, next, ctx.todayIso);
        goals.push({ id: env.id, name: env.name, before: b, after: a });
        if (a.status === 'outside') {
          if (next.daily.some((point, i) => point.balance < (previous.daily[i]?.balance ?? Infinity) - 0.005)) blockers.push({ kind: 'unknownGoal', id: env.id, name: env.name });
        } else if (a.projected !== null && b.projected !== null && a.projected < b.projected - 0.005 && a.projected < a.target - 0.005) {
          blockers.push({ kind: 'goal', id: env.id, name: env.name });
        }
      }
    }
    if (remainingGap >= gap - 0.005) blockers.push({ kind: 'noImprovement', id: target.id, name: target.name });
    const canApply = blockers.length === 0;
    return ok({ ...base, preview: { source: sources.length === 1 ? sources[0] : null, sources, total: neededCents / 100, changes, goals, remainingGap, blockers, canApply,
      steps: canApply ? steps : [] } });
  },
};
