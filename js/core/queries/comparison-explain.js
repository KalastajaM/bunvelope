import { historyPoint, validHistory } from '../financial-history.js';
import { ok, fail } from '../result.js';
import { LENS_INPUT, lensRows } from '../lens-input.js';
import { round2 } from '../../utils.js';
import { COLLECTIONS, same, comparisonData, comparisonClock, comparisonAmount, validComparison, unavailable } from '../comparison.js';
import { comparisonSources, comparisonMetaSources } from '../comparison-sources.js';

// Group effects are an ordered bridge, not independent causal estimates.
// Recalculate after each group so interactions reconcile to the final amount.

export default {
  name: 'comparison.explain',
  summary: 'Explain a number since a chosen date using automatic financial history (start of day, or first capture on the first recorded day). Legacy comparison.save points remain usable on their exact date. Explain changes using existing money queries. Metrics: netWorth (current balance view), forecast (Overview’s twelfth monthly point), spare (one envelope’s 12-month spare), unrealized (priced tracked holdings P/L). Ordered group effects sum to the total change; interactions depend on order. Clock and view changes are separate. Sources identify changed records, not per-record monetary effects. Returns unavailable for dates outside recorded history, absent endpoint metrics or currency changes. With no date, defaults to continuous history start or a legacy saved point.',
  input: { type: 'object', properties: {
    ...LENS_INPUT,
    date: { type: 'date', description: 'Compare from the start of this date, or the first recorded point on the first history day' },
    metric: { enum: ['netWorth', 'forecast', 'spare', 'unrealized'], default: 'netWorth' },
    envelope: { type: 'string', description: 'Envelope id for spare; accepts a deleted id to report unavailable instead of inventing zero.' },
  } },
  run(data, input, ctx) {
    const h = data.meta?.financialHistory;
    const coverage = validHistory(h) ? { start: h.start, gap: !!h.gap } : null;
    const selected = input.date || (coverage ? coverage.start.date : null);
    if (selected && selected > ctx.todayIso) return fail('bad_input', { errors: [{ path: 'date', message: 'Cannot compare with a future date.' }] });
    let point = selected ? historyPoint(data, selected) : null;
    const source = point ? 'history' : 'savedPoint';
    if (!point && (!selected || selected === data.meta?.comparisonPoint?.date)) point = data.meta?.comparisonPoint;
    if (!point) return ok(selected ? { status: 'unavailable', reason: 'history', coverage } : { status: 'missing' });
    if (source === 'history') point = { ...point, view: { lens: input.lens || 'booked', ...(input.horizon ? { horizon: input.horizon } : {}) } };
    if (!validComparison(point)) return unavailable();
    if (input.metric === 'spare' && !input.envelope) return fail('bad_input', { errors: [{ path: 'envelope', message: 'required for spare' }] });
    const checked = lensRows(data, input, ctx);
    if (!checked.ok) return checked;
    const current = comparisonData(data);
    const view = { lens: input.lens || 'booked', ...(input.horizon === undefined ? {} : { horizon: input.horizon }) };
    const savedCtx = comparisonClock(point.date, ctx);
    const currentCtx = comparisonClock(ctx.todayIso, ctx);
    const previous = comparisonAmount(point.data, input, point.view, savedCtx);
    if (!previous.ok) return previous;
    const latest = comparisonAmount(current, input, view, currentCtx);
    if (!latest.ok) return latest;
    const basis = { metric: input.metric, envelope: input.envelope || null, savedAt: point.at,
      source, coverage, partialDay: !!point.partialDay, revisions: point.revisions ?? null,
      beforeDate: point.date, afterDate: ctx.todayIso, beforeView: point.view, afterView: view,
      before: previous.value, after: latest.value };
    if (point.data.meta.currency !== current.meta.currency) return ok({ ...basis, status: 'unavailable', reason: 'currency' });
    if (![previous.value, latest.value].every(Number.isFinite)) return ok({ ...basis, status: 'unavailable', reason: 'metric' });

    let working = point.data;
    let amount = previous.value;
    const steps = [];
    const add = (group, next, clock, lens, sources = []) => {
      const r = comparisonAmount(next, input, lens, clock);
      if (!r.ok || !Number.isFinite(r.value)) return false;
      steps.push({ group, delta: round2(r.value - amount), after: r.value, count: sources.length, sources: sources.slice(0, 100) });
      working = next;
      amount = r.value;
      return true;
    };
    for (const group of COLLECTIONS) {
      if (same(working[group], current[group])) continue;
      if (!add(group, { ...working, [group]: current[group] }, savedCtx, point.view, comparisonSources(group, point.data, current))) {
        return ok({ ...basis, status: 'unavailable', reason: 'metric' });
      }
    }
    /** @type {[string, string[]][]} */
    const metaGroups = [['settings', ['country', 'scheduledTombstones', 'stressExpenses', 'closed_months', 'reopened_months', 'policies']], ['investments', ['investments']]];
    for (const [group, fields] of metaGroups) {
      if (fields.every(k => same(working.meta[k], current.meta[k]))) continue;
      const meta = { ...working.meta, ...Object.fromEntries(fields.map(k => [k, current.meta[k]])) };
      if (!add(group, { ...working, meta }, savedCtx, point.view, comparisonMetaSources(group, fields, point.data, current))) return ok({ ...basis, status: 'unavailable', reason: 'metric' });
    }
    if (point.date !== ctx.todayIso && !add('date', working, currentCtx, point.view)) return unavailable();
    if (!same(point.view, view) && !add('view', working, currentCtx, view)) return unavailable();
    // Fail closed if a new calculation input is added without a bridge group.
    if (round2(amount - latest.value) !== 0) return unavailable();
    return ok({ ...basis, status: 'ready', delta: round2(latest.value - previous.value), steps });
  },
};
