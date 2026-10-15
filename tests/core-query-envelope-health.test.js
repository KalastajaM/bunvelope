// tests/core-query-envelope-health.test.js — the Envelope health sheet as a
// query: `envelope.health`, the 12-month projection (series, months, low,
// high, closing), the engine's recommendations, the item funding, and the
// lens and as-of balances the sheet shows.
//
// The equivalence helper copies envelope-health.js L176-251 verbatim, with
// `state` → the fixture, `appNow()` → the fixed clock and `viewTxs()` →
// `lensTransactions` for the lens. The answer must equal the page's figures,
// with the projection's Maps and events left out.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions, resolveHorizonDate } from '../js/engine/lens.js';
import { computeEnvelopeBalances } from '../js/engine/balances.js';
import { projectEnvelopeBalance, recommendEnvelopeActions } from '../js/engine/envelope-forecast.js';
import { computeItemFunding } from '../js/engine/item-funding.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'envelope.health', input, ctxAt(now));
const answer = (input, d, now = NOW) => {
  const r = ask(input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// 15 Sep 2026. Rent pays a 700 bill on the 10th that has not been posted this
// month (due, unposted) and is filled 600 a month by a template: it runs out
// (top-up and fill recommendations). Food is a spending envelope with an
// extra buffer, a scheduled future spend (Booked ≠ the projection's opening)
// and a monthly fill; Trip has a goal it will not reach; Old is archived.
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: [] },
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }],
  envelopes: [
    { id: 'food', name: 'Food' },
    { id: 'rent', name: 'Rent' },
    { id: 'trip', name: 'Trip', goal_amount: 3000, goal_date: '2027-03-01' },
    { id: 'old', name: 'Old', archived: true },
  ],
  budgetItems: [
    { id: 'groc', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -300, extra_buffer: 40, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'rentb', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -700, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, account_id: 'chk', payment_day: 10, schedule_day_type: 'exact', as_schedule_since: '2026-08-01' },
  ],
  envelopeTemplates: [
    { id: 'tpl', name: 'Monthly', kind: 'manual',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'rent', mode: 'add', amount: 600 }, { envelope_id: 'trip', mode: 'add', amount: 100 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every() } },
  ],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 5000, account: 'chk', status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 450 }, { envelope_id: 'rent', mode: 'add', amount: 900 },
        { envelope_id: 'trip', mode: 'add', amount: 500 }, { envelope_id: 'old', mode: 'add', amount: 30 }] },
    { id: 'r8', type: 'expense', date: '2026-08-10', payee: 'Landlord', amount: 700, account: 'chk', envelope_id: 'rent', status: 'posted', from_budget: 'rentb:2026-08' },
    { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 120.5, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 's1', type: 'expense', date: '2026-09-25', payee: 'Market', amount: 60, account: 'chk', envelope_id: 'food', status: 'scheduled' },
  ],
  ...extra,
});

// envelope-health.js L176-251 verbatim (the figures, not the DOM), with the
// months the query is asked for in place of the page's 12.
function pageHealth(state, appNow, { lens, horizon }, envelope, months = 12) {
  const viewTxs = () => lensTransactions(state, { lens, horizon, today: appNow });
  const input = {
    envelopeId: envelope.id,
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: state.envelopes,
    today: appNow,
    months,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  };
  const projection = projectEnvelopeBalance(input);
  const recs = recommendEnvelopeActions(input, projection);
  const lensBalance = computeEnvelopeBalances(viewTxs()).get(envelope.id) ?? 0;
  const funding = computeItemFunding({
    envelopeId: envelope.id,
    budgetItems: state.budgetItems || [],
    transactions: state.transactions,
    balance: computeEnvelopeBalances(state.transactions, { asOf: input.today }).get(envelope.id) ?? 0,
    today: input.today,
    country: input.country,
    tombstones: input.tombstones,
    // The same walk the chart above draws: an item is short exactly where it dips.
    daily: projection.daily,
  });
  const asOfBalance = computeEnvelopeBalances(state.transactions, { asOf: input.today }).get(envelope.id) ?? 0;
  return { projection, recs, lensBalance, funding, asOfBalance };
}
const point = (p) => (p ? { date: p.date, balance: round2(p.balance) } : null);
// The page's figures in the answer's shape: the projection without its events
// and Maps, money in cents; recommendations and funding as the engine returns
// them.
function expected(d, now, lensInput, id, months) {
  const env = d.envelopes.find(e => e.id === id);
  const lensOf = { lens: lensInput.lens, horizon: lensInput.horizon ? resolveHorizonDate(lensInput.horizon, now) : undefined };
  const { projection: p, recs, lensBalance, funding, asOfBalance } = pageHealth(d, now, lensOf, env, months);
  return {
    envelope: id,
    projection: {
      opening: round2(p.opening),
      dueUnposted: round2(p.dueUnposted ?? 0),
      daily: p.daily.map(point),
      months: p.months.map(m => ({ key: m.key, opening: round2(m.opening), in: round2(m.in), out: round2(m.out),
        low: round2(m.low), high: round2(m.high), closing: round2(m.closing), partial: m.partial })),
      low: point(p.low),
      high: point(p.high),
      closing: round2(p.closing),
      firstNegative: point(p.firstNegative),
      monthlyFill: round2(p.monthlyFill),
      fillSource: p.fillSource,
      unresolved: p.unresolved === true,
    },
    recommendations: recs,
    funding,
    lensBalance: round2(lensBalance),
    asOfBalance: round2(asOfBalance),
  };
}

describe('envelope.health — equals the health sheet', () => {
  for (const id of ['food', 'rent', 'trip']) {
    for (const [label, lensInput] of [['booked', {}], ['today', { lens: 'today' }], ['forecast', { lens: 'forecast', horizon: 'eom' }]]) {
      it(`${id}, ${label}`, () => {
        const d = data();
        const a = answer({ envelope: id, ...lensInput }, d);
        expect(a).toEqual(expected(d, NOW, { lens: lensInput.lens ?? 'booked', horizon: lensInput.horizon }, id, 12));
        jsonSafe(a);
      });
    }
  }

  for (const months of [1, 3, 24]) {
    it(`months ${months}`, () => {
      const d = data();
      expect(answer({ envelope: 'rent', months }, d)).toEqual(expected(d, NOW, { lens: 'booked' }, 'rent', months));
    });
  }

  it('date is the projection\'s first day, the funding month and the as-of day', () => {
    const d = data();
    expect(answer({ envelope: 'food', date: '2026-10-20' }, d)).toEqual(expected(d, at(2026, 10, 20), { lens: 'booked' }, 'food', 12));
  });

  it('the figures, worked out', () => {
    const a = answer({ envelope: 'rent' }, data());
    // 900 − 700 in August; September's 700 of the 10th is due and unposted.
    expect(a.projection).toMatchObject({ opening: -500, dueUnposted: 700, fillSource: 'scheduled', monthlyFill: 600, unresolved: false });
    expect(a.projection.daily).toHaveLength(365);
    expect(a.projection.months).toHaveLength(13);
    expect(a.projection.months[0]).toMatchObject({ key: '2026-09', partial: true });
    // October: the 600 fill on the 1st, the 700 bill on the 10th; the walk
    // loses 100 a month and ends at −500 − 12 × 100.
    expect(a.projection.months[1]).toEqual({ key: '2026-10', opening: -500, in: 600, out: -700, low: -600, high: 100, closing: -600, partial: false });
    expect(a.projection).toMatchObject({ low: { date: '2027-09-10', balance: -1700 }, high: { date: '2026-10-01', balance: 100 }, closing: -1700 });
    expect(a.projection.firstNegative).toEqual({ date: '2026-09-15', balance: -500 });
    expect(a.lensBalance).toBe(200);
    expect(a.asOfBalance).toBe(200);
    expect(a.recommendations.map(r => [r.kind, r.severity, r.amount, r.date])).toEqual([
      ['shortfall-topup', 'critical', 1701, '2026-09-16'],
      ['shortfall-monthly', 'critical', null, null],
    ]);
    expect(a.recommendations[0].meta).toEqual({ floor: 0, low: { date: '2027-09-10', balance: -1700 }, unsolvable: false });
    // The 200 held covers 200 of September's 700, due on the 10th: 500 short.
    expect(a.funding).toEqual({
      items: [{ itemId: 'rentb', name: 'Rent', style: 'bill', planThisMonth: 700, spent: 0, remaining: 700, overspent: 0, allocated: 200,
        pct: 200 / 700, status: 'short', shortBy: 500, shortDate: '2026-09-10', nextDue: { date: '2026-09-10', amount: 700 } }],
      reserve: 0, reserveAllocated: 0, unassigned: 0, shortfall: 500, unlinkedSpent: 0,
    });
    // Food: the scheduled 60 of the 25th is in Booked, not yet left as of today.
    const food = answer({ envelope: 'food' }, data());
    expect([food.lensBalance, food.asOfBalance]).toEqual([269.5, 329.5]);
    expect(food.funding).toMatchObject({ reserve: 40, reserveAllocated: 40, unassigned: 110 });
    expect(food.recommendations).toEqual([]);
    // Trip will not reach 3000 by March (1100 projected): 317 a month more.
    expect(answer({ envelope: 'trip' }, data()).recommendations[0]).toEqual({
      kind: 'goal-shortfall', severity: 'warn', amount: 317, date: '2027-03-01',
      meta: { goalAmount: 3000, projected: 1100, beyondWindow: false, cutoff: '2027-03-01', currentFill: 100, fillMode: 'add', unsolvable: false },
    });
  });

  it('an archived envelope is unresolved: a flat zero, said so', () => {
    const d = data();
    const a = answer({ envelope: 'old' }, d);
    expect(a).toEqual(expected(d, NOW, { lens: 'booked' }, 'old', 12));
    expect(a.projection).toMatchObject({ unresolved: true, opening: 0, dueUnposted: 0, months: [], daily: [{ date: '2026-09-15', balance: 0 }] });
    expect(a.recommendations).toEqual([{ kind: 'warn-unresolved-envelope', severity: 'warn', amount: null, date: null, meta: {} }]);
    expect(a.lensBalance).toBe(30);
  });

  it('refuses an unknown envelope, months outside 1..24 and a horizon without the forecast lens', () => {
    const d = data();
    expect(ask({ envelope: 'nope' }, d).error.code).toBe('bad_input');
    expect(ask({}, d).error.code).toBe('bad_input');
    expect(ask({ envelope: 'food', months: 0 }, d).error.code).toBe('bad_input');
    expect(ask({ envelope: 'food', months: 25 }, d).error.code).toBe('bad_input');
    expect(ask({ envelope: 'food', horizon: 'eom' }, d).error.code).toBe('bad_input');
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = data();
    const before = JSON.stringify(d);
    answer({ envelope: 'rent', lens: 'forecast' }, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
