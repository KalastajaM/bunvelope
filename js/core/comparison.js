// Shared calculation inputs for historical comparisons and legacy review points.
// Never nest history, checkpoints, or private AI/UI metadata.
import { deepEqual } from './diff.js';
import { makeCtx } from './context.js';
import { refDate, isHorizon } from './lens-input.js';
import { ok, fail } from './result.js';
import netWorth from './queries/net-worth-current.js';
import simulation from './queries/forecast-simulation.js';
import envelopes from './queries/envelopes-month.js';

export const COMPARISON_VERSION = 1;
export const COLLECTIONS = ['accounts', 'envelopes', 'transactions', 'budgetItems', 'envelopeTemplates'];
export const same = deepEqual;

// Internal read-only projection. It borrows collection references so comparison
// and diff operations need not clone a ledger they only inspect. Callers that
// retain or expose a snapshot must use comparisonData or clone the result.
export function comparisonInputs(data) {
  const meta = data.meta || {};
  return {
    ...Object.fromEntries(COLLECTIONS.map(k => [k, data[k] || []])),
    meta: {
      country: meta.country || 'FI',
      currency: meta.currency || 'EUR',
      scheduledTombstones: meta.scheduledTombstones || [],
      investments: meta.investments || {},
      stressExpenses: meta.stressExpenses || [],
      closed_months: meta.closed_months || [],
      reopened_months: meta.reopened_months || [],
      policies: meta.policies || [],
    },
  };
}

export function comparisonData(data) {
  return structuredClone(comparisonInputs(data));
}

export function comparisonClock(date, ctx) {
  return makeCtx({ now: refDate({ date }, ctx), newId: ctx.newId });
}

export function comparisonAmount(data, input, view, ctx) {
  if (input.metric === 'spare') {
    if (!data.envelopes.some(e => e.id === input.envelope && !e.archived)) return ok(null);
    const r = envelopes.run(data, { envelopes: [input.envelope], ...view }, ctx);
    return r.ok ? ok(r.value.envelopes[0]?.spare?.spare ?? null) : r;
  }
  if (input.metric === 'forecast') {
    const r = simulation.run(data, { months: 12, shiftPct: 0, alerts: false }, ctx);
    // Overview renders points.slice(0, 12), including this partial month.
    // The simulation also returns the following month; do not explain that
    // extra endpoint as though it were the number visible in Overview.
    return r.ok ? ok(r.value.points.slice(0, 12).at(-1)?.total ?? null) : r;
  }
  const r = netWorth.run(data, view, ctx);
  if (!r.ok) return r;
  if (input.metric === 'unrealized') return ok(r.value.unrealized.hasData ? r.value.unrealized.pl : null);
  return ok(r.value.total);
}

export function validComparison(point) {
  return point?.version === COMPARISON_VERSION
    && typeof point.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(point.date) && isHorizon(point.date)
    && point.data?.meta && point.view
    && ['today', 'booked', 'forecast'].includes(point.view.lens)
    && (point.view.horizon === undefined || (point.view.lens === 'forecast' && isHorizon(point.view.horizon)))
    && COLLECTIONS.every(k => Array.isArray(point.data[k]) && point.data[k].every(row => row && typeof row === 'object'));
}

export const unavailable = () => fail('bad_input', { errors: [{ path: 'comparison', message: 'Comparison unavailable. Save a new comparison point.' }] });
