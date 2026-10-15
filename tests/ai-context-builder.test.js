// tests/ai-context-builder.test.js — pure-function checks on the AI context
// builders. No network, no mocks.

import { describe, it, expect } from 'vitest';
import {
  withCurrency,
  currencySymbolFor,
  buildMonthlyBriefingCtx,
  buildAnomalyCtx,
  buildEnvelopeHealthCtx,
  buildSubscriptionCtx,
  buildWhatifCtx,
  buildOnboardingCtx,
  buildSearchCtx,
  anomalyKey,
} from '../js/ai/context-builder.js';
import { queryAnswer } from '../js/ai/query.js';
import { takenOccurrenceKeys } from '../js/core/effective-txs.js';
import { forecastScheduledTransactions, forecastAllFills, forecastKey } from '../js/engine.js';

// The fixture's rows are dated back from the wall clock, so builders that
// require a clock are given the wall clock here.
const WALL = () => new Date();

// Each builder as a one-argument function over the state, named for its failures.
const named = (name, fn) => Object.defineProperty(fn, 'name', { value: name });
const BUILDERS = [
  named('briefing', (st) => buildMonthlyBriefingCtx(st, undefined, WALL)),
  named('anomaly', (st) => buildAnomalyCtx(st, undefined, WALL)),
  named('health', (st) => buildEnvelopeHealthCtx(st, undefined, WALL)),
  named('subscription', (st) => buildSubscriptionCtx(st, WALL)),
  named('whatif', (st) => buildWhatifCtx(st, undefined, WALL)),
  named('search', (st) => buildSearchCtx(st, WALL)),
];

function makeFixtureState() {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => iso(new Date(today.getTime() - n * 86_400_000));

  const envelopes = Array.from({ length: 12 }, (_, i) => ({
    id: `env-${i}`, name: `Envelope ${i}`, category: i % 3 === 0 ? 'Bills' : 'Living',
    archived: false,
  }));
  const accounts = [
    { id: 'acc-1', name: 'Checking', type: 'checking' },
    { id: 'acc-2', name: 'Savings',  type: 'savings'  },
  ];
  const transactions = [];
  // Recurring grocery payee, monthly, ~50€
  for (let m = 0; m < 6; m++) {
    transactions.push({
      id: `tx-grocery-${m}`, type: 'expense', status: 'posted',
      date: daysAgo(7 + m * 30), amount: 50 + m * 0.5, payee: 'Prisma',
      envelope_id: 'env-1', account: 'acc-1', notes: 'private note',
    });
  }
  // Random one-off larger expense
  transactions.push({
    id: 'tx-spike', type: 'expense', status: 'posted',
    date: daysAgo(10), amount: 423.77, payee: 'Verkkokauppa',
    envelope_id: 'env-2', account: 'acc-1', notes: 'secret',
  });
  // Income
  transactions.push({
    id: 'tx-pay', type: 'income', status: 'posted',
    date: daysAgo(15), amount: 3000, payee: 'Employer', account: 'acc-1',
  });
  const budgetItems = envelopes.slice(0, 6).map((e, i) => ({
    id: `bi-${i}`, envelope_id: e.id, default_amount: 100 + i * 5,
    monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true,
      Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
    extra_buffer: 0, include: true, include_in_emergency_budget: false,
  }));
  return { envelopes, accounts, transactions, budgetItems, envelopeTemplates: [], meta: { ai: {} } };
}

function jsonSize(v) { return new TextEncoder().encode(JSON.stringify(v)).length; }

function deepValues(v, found = []) {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) v.forEach((x) => deepValues(x, found));
    else for (const k of Object.keys(v)) {
      found.push([k, v[k]]);
      deepValues(v[k], found);
    }
  }
  return found;
}

describe('AI context-builder', () => {
  it('rounds money to 2 decimals across briefing payload', () => {
    const ctx = buildMonthlyBriefingCtx(makeFixtureState(), undefined, WALL);
    for (const [, v] of deepValues(ctx)) {
      if (typeof v === 'number' && Number.isFinite(v) && v !== Math.trunc(v)) {
        const rounded = Math.round(v * 100) / 100;
        expect(v).toBeCloseTo(rounded, 6);
      }
    }
  });

  it('drops free-text notes from anomaly transactions', () => {
    const ctx = buildAnomalyCtx(makeFixtureState(), undefined, WALL);
    for (const tx of ctx.transactions) {
      expect(tx.notes).toBeUndefined();
      expect(tx.note).toBeUndefined();
    }
  });

  it('groups baseline transactions with no payee under "(no payee)", same as the reports label', () => {
    const state = makeFixtureState();
    const today = new Date();
    const daysAgo = (n) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 4; i++) {
      state.transactions.push({
        id: `tx-nopayee-${i}`, type: 'expense', status: 'posted',
        date: daysAgo(20 + i * 10), amount: 12,
        envelope_id: 'env-1', account: 'acc-1',
      });
    }
    const ctx = buildAnomalyCtx(state, undefined, WALL);
    expect(ctx.baseline['(no payee)']).toBeTruthy();
    expect(ctx.baseline['(no payee)'].n).toBe(4);
  });

  // The add form leaves `status` off a posted row (isPostedTx reads absent as
  // posted), so a strict `status === 'posted'` check hid every hand entry.
  it('counts rows without a status as posted, and leaves scheduled rows out', () => {
    const state = makeFixtureState();
    const today = new Date();
    const daysAgo = (n) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) {
      state.transactions.push({
        id: `tx-gym-${i}`, type: 'expense', date: daysAgo(5 + i * 30), amount: 39,
        payee: 'Gym', envelope_id: 'env-4', account: 'acc-1',
      });
      state.transactions.push({
        id: `tx-planned-${i}`, type: 'expense', status: 'scheduled', date: daysAgo(6 + i * 30),
        amount: 20, payee: 'Planned', envelope_id: 'env-5', account: 'acc-1',
      });
    }
    const anomaly = buildAnomalyCtx(state, undefined, WALL);
    expect(anomaly.baseline.Gym?.n).toBe(3);
    expect(anomaly.transactions.some((t) => t.id === 'tx-gym-0')).toBe(true);
    expect(anomaly.transactions.some((t) => t.id === 'tx-planned-0')).toBe(false);
    const subs = buildSubscriptionCtx(state, WALL);
    expect(subs.candidates.find((c) => c.payee === 'Gym')).toBeTruthy();
    expect(subs.candidates.find((c) => c.payee === 'Planned')).toBeUndefined();
  });

  it('subscription detection excludes payees with <3 occurrences', () => {
    const state = makeFixtureState();
    // Verkkokauppa appears once → must not be a candidate.
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Verkkokauppa')).toBeUndefined();
    // Prisma appears 6 times → should be a candidate.
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeTruthy();
  });

  it('respects dismissedSubs from meta', () => {
    const state = makeFixtureState();
    state.meta.ai.dismissedSubs = ['Prisma'];
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeUndefined();
  });

  it('excludes payees that already have transactions from a scheduled budget item', () => {
    const state = makeFixtureState();
    // Mark one of Prisma's transactions as materialized from a budget item.
    const someTx = state.transactions.find((tx) => tx.payee === 'Prisma');
    someTx.from_budget = 'bi-rent:2026-04';
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeUndefined();
  });

  it('excludes payees whose name matches a scheduled budget item description', () => {
    const state = makeFixtureState();
    state.budgetItems.push({
      id: 'bi-prisma', envelope_id: 'env-1', description: 'Prisma',
      default_amount: 50, monthly_schedule: { Jan: true },
      extra_buffer: 0, include: true, as_schedule: true,
    });
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeUndefined();
  });

  it('search context payload stays under 8 KB on 100 envelopes', () => {
    const state = makeFixtureState();
    state.envelopes = Array.from({ length: 100 }, (_, i) => ({
      id: `e${i}`, name: `Envelope ${i}`, category: 'Living', archived: false,
    }));
    const ctx = buildSearchCtx(state, WALL);
    expect(jsonSize(ctx)).toBeLessThan(8 * 1024);
  });

  it('envelope_health rows reference real envelopes only', () => {
    const ctx = buildEnvelopeHealthCtx(makeFixtureState(), undefined, WALL);
    const ids = new Set(ctx.envelopes.map((e) => e.id));
    for (const e of ctx.envelopes) {
      expect(ids.has(e.id)).toBe(true);
      expect(typeof e.balance).toBe('number');
      expect(typeof e.monthly_plan).toBe('number');
    }
  });

  it('whatif forecast horizon is bounded to 60 entries', () => {
    const ctx = buildWhatifCtx(makeFixtureState(), undefined, WALL);
    expect(ctx.forecast90d.length).toBeLessThanOrEqual(60);
  });

  it('whatif forecast is date-ordered so the 60-row cap truncates chronologically', () => {
    const ctx = buildWhatifCtx(makeFixtureState(), undefined, WALL);
    const dates = ctx.forecast90d.map((f) => f.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('whatif forecast leaves out occurrences the user deleted (tombstones)', () => {
    // A deleted scheduled bill is recorded in meta.scheduledTombstones; the
    // materialiser and the Transactions page skip it, and so must this.
    const state = makeFixtureState();
    const allMonths = { Jan: 12, Feb: 12, Mar: 12, Apr: 12, May: 12, Jun: 12,
      Jul: 12, Aug: 12, Sep: 12, Oct: 12, Nov: 12, Dec: 12 };
    state.budgetItems.push({
      id: 'bi-power', kind: 'expense', description: 'Power', envelope_id: 'env-0',
      account_id: 'acc-1', as_schedule: true, payment_day: 15, default_amount: 12,
      monthly_schedule: allMonths, include: true,
    });
    const powerRows = (ctx) => ctx.forecast90d.filter((f) => f.payee === 'Power');
    const before = powerRows(buildWhatifCtx(state, undefined, WALL));
    expect(before.length).toBeGreaterThan(1);

    const firstMonth = before[0].date.slice(0, 7);
    state.meta.scheduledTombstones = [`bi-power:${firstMonth}`];
    const after = powerRows(buildWhatifCtx(state, undefined, WALL));
    expect(after.length).toBe(before.length - 1);
    expect(after.some((f) => f.date.startsWith(firstMonth))).toBe(false);
  });

  it('whatif forecast includes fills, with a real amount rather than 0', () => {
    // Without the fill leg the model sees only money leaving envelopes over the
    // next 90 days, and reasons about a budget that never gets funded. And a
    // fill has `lines`, not `amount`, so the generic mapping yielded 0.
    const state = makeFixtureState();
    const allMonths = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
      Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
    state.envelopeTemplates = [{
      id: 'tpl-monthly', name: 'Monthly allocation', kind: 'manual',
      lines: [
        { envelope_id: 'env-1', mode: 'add', amount: 300 },
        { envelope_id: 'env-2', mode: 'add', amount: 200 },
      ],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: allMonths },
    }];

    const fills = buildWhatifCtx(state, undefined, WALL).forecast90d.filter((f) => f.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      expect(f.amount).toBe(500);
      expect(f.account_id).toBeNull();               // a fill touches no account
      expect(f.envelope_ids).toEqual(['env-1', 'env-2']);
    }
  });

  it('whatif forecast drops a fill that has already been posted', () => {
    const state = makeFixtureState();
    const allMonths = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
      Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
    state.envelopeTemplates = [{
      id: 'tpl-monthly', name: 'Monthly allocation', kind: 'manual',
      lines: [{ envelope_id: 'env-1', mode: 'add', amount: 300 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: allMonths },
    }];

    const before = buildWhatifCtx(state, undefined, WALL).forecast90d.filter((f) => f.type === 'fill');
    expect(before.length).toBeGreaterThan(0);

    // Post every forecast occurrence, keyed exactly as the materialiser would.
    const months = new Set(before.map((f) => f.date.slice(0, 7)));
    for (const mk of months) {
      state.transactions.push({
        id: `posted-${mk}`, type: 'fill', status: 'posted', source: 'allocation',
        date: `${mk}-01`, from_budget: `tpl:tpl-monthly:${mk}`,
        lines: [{ envelope_id: 'env-1', mode: 'add', amount: 300 }],
      });
    }
    const after = buildWhatifCtx(state, undefined, WALL).forecast90d.filter((f) => f.type === 'fill');
    expect(after).toEqual([]);
  });

  it('whatif forecast serialises from/to account ids for a planned account transfer', () => {
    // account_transfer rows carry from_account/to_account, never `account` —
    // the generic mapping's `account_id: tx.account || null` loses both ends.
    const state = makeFixtureState();
    const allMonths = { Jan: 40, Feb: 40, Mar: 40, Apr: 40, May: 40, Jun: 40,
      Jul: 40, Aug: 40, Sep: 40, Oct: 40, Nov: 40, Dec: 40 };
    state.budgetItems.push({
      id: 'bi-transfer', kind: 'account_transfer', description: 'Savings sweep',
      account_id: 'acc-1', to_account_id: 'acc-2',
      as_schedule: true, payment_day: 5, default_amount: 40,
      monthly_schedule: allMonths, include: true,
    });
    const rows = buildWhatifCtx(state, undefined, WALL).forecast90d.filter((f) => f.type === 'account_transfer');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.from_account_id).toBe('acc-1');
      expect(r.to_account_id).toBe('acc-2');
      expect(r.account_id).toBeNull();
      expect(r.amount).toBe(40);
    }
  });

  it('whatif forecast leaves account_id/from/to alone for an ordinary expense', () => {
    const state = makeFixtureState();
    const allMonths = { Jan: 12, Feb: 12, Mar: 12, Apr: 12, May: 12, Jun: 12,
      Jul: 12, Aug: 12, Sep: 12, Oct: 12, Nov: 12, Dec: 12 };
    state.budgetItems.push({
      id: 'bi-power', kind: 'expense', description: 'Power', envelope_id: 'env-0',
      account_id: 'acc-1', as_schedule: true, payment_day: 15, default_amount: 12,
      monthly_schedule: allMonths, include: true,
    });
    const expenseRows = buildWhatifCtx(state, undefined, WALL).forecast90d.filter((f) => f.type === 'expense');
    expect(expenseRows.length).toBeGreaterThan(0);
    for (const r of expenseRows) {
      expect(r.account_id).toBe('acc-1');
      expect(r.from_account_id).toBeUndefined();
      expect(r.to_account_id).toBeUndefined();
    }
  });

  it('onboarding context exposes counts only', () => {
    const ctx = buildOnboardingCtx(makeFixtureState(), undefined, WALL);
    expect(ctx.counts).toBeTruthy();
    expect(typeof ctx.counts.envelopes).toBe('number');
    // No transactions, envelope ids, or amounts in onboarding context.
    expect(JSON.stringify(ctx)).not.toMatch(/\bPrisma\b/);
  });

  it('refs map ids to names without leaking transactions', () => {
    const ctx = buildEnvelopeHealthCtx(makeFixtureState(), undefined, WALL);
    expect(ctx.refs.envelopes['env-0']).toBe('Envelope 0');
    expect(ctx.refs.accounts['acc-1']).toBe('Checking');
  });

  it('buildAnomalyCtx excludes transactions whose key is in meta.ai.dismissed.anomaly', () => {
    const state = makeFixtureState();
    // Pick the spike transaction, compute its key, persist a dismissal.
    const spike = state.transactions.find((tx) => tx.id === 'tx-spike');
    const k = anomalyKey(spike.envelope_id, spike.payee, Math.abs(spike.amount));
    state.meta.ai.dismissed = { anomaly: { [k]: { dismissedAt: '2026-04-28T00:00:00Z' } } };
    const ctx = buildAnomalyCtx(state, undefined, WALL);
    expect(ctx.transactions.find((t) => t.id === 'tx-spike')).toBeUndefined();
  });

  it('buildEnvelopeHealthCtx excludes envelopes whose id is in meta.ai.dismissed.envelope_health', () => {
    const state = makeFixtureState();
    state.meta.ai.dismissed = { envelope_health: { 'env-1': { dismissedAt: '2026-04-28T00:00:00Z' } } };
    const ctx = buildEnvelopeHealthCtx(state, undefined, WALL);
    expect(ctx.envelopes.find((e) => e.id === 'env-1')).toBeUndefined();
    // Other envelopes still present.
    expect(ctx.envelopes.find((e) => e.id === 'env-0')).toBeTruthy();
  });

  it('buildSubscriptionCtx honours the new dismissed.subscription map', () => {
    const state = makeFixtureState();
    state.meta.ai.dismissed = { subscription: { 'Prisma': { dismissedAt: '2026-04-28T00:00:00Z' } } };
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeUndefined();
  });

  it('buildSubscriptionCtx keeps a dismissal after the payee is merged into a new name', () => {
    const state = makeFixtureState();
    // Dismissed as "PRISMA 42", then merged in the tidy-up sheet into
    // "Prisma", which recorded the old spelling as an alias.
    state.meta.ai.dismissed = { subscription: { 'PRISMA 42': { dismissedAt: '2026-04-28T00:00:00Z' } } };
    state.meta.payeeAliases = { 'prisma 42': 'Prisma' };
    const ctx = buildSubscriptionCtx(state, WALL);
    expect(ctx.candidates.find((c) => c.payee === 'Prisma')).toBeUndefined();
  });

  it('builders never include payee notes', () => {
    const state = makeFixtureState();
    for (const build of BUILDERS.filter((b) => b.name !== 'search')) {
      expect(JSON.stringify(build(state)), build.name).not.toMatch(/private note|secret/);
    }
  });
});


// ── Core queries behind the summary and the what-if forecast ─────────────
//
// A fixed local clock, so the day is the same in every zone.
const CLOCK = () => new Date(2026, 8, 15, 10, 0, 0);
const JAN_ONLY = (v) => ({ Jan: v, Feb: 0, Mar: 0, Apr: 0, May: 0, Jun: 0, Jul: 0, Aug: 0, Sep: 0, Oct: 0, Nov: 0, Dec: 0 });
const ALL_MONTHS = (v) => Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => [m, v]));

// Hand-worked: Checking 1000 - 40 - 15 = 945; the Broker (investment) holds 500
// and is not account money. Food has a 300 fill less 55 spent = 245 left.
// September spending is the 40 (the 15 is August). The food item is 1200 a
// year, all of it booked in January.
function summaryState() {
  return {
    meta: { currency: 'EUR', country: 'FI' },
    accounts: [
      { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 500 },
    ],
    envelopes: [{ id: 'food', name: 'Food', category: 'Living' }],
    transactions: [
      { id: 'f1', type: 'fill', status: 'posted', source: 'allocation', date: '2026-09-01', lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }] },
      { id: 'e1', type: 'expense', status: 'posted', date: '2026-09-05', payee: 'Shop', amount: 40, account: 'chk', envelope_id: 'food' },
      { id: 'e2', type: 'expense', status: 'posted', date: '2026-08-05', payee: 'Shop', amount: 15, account: 'chk', envelope_id: 'food' },
    ],
    budgetItems: [{ id: 'bi', kind: 'expense', description: 'Food', envelope_id: 'food', default_amount: -1200, include: true, monthly_schedule: JAN_ONLY(-1200) }],
    envelopeTemplates: [],
  };
}

describe('the dashboard summary reads the core queries', () => {
  // Before (computeDashboardSummary): totalAccountBalance 1445, plannedThisMonth 0.
  const EXPECTED = {
    totalEnvelopeBalance: 245,
    totalAccountBalance: 945,   // identity accounts: the Broker's 500 is left out
    unallocated: 700,
    spentThisMonth: 40,
    plannedThisMonth: 100,      // the annual 1200 / 12, not September's own calendar entry (0)
  };

  it('the briefing summary is the balances totals and the month\u2019s spending', () => {
    expect(buildMonthlyBriefingCtx(summaryState(), '2026-09', CLOCK).summary).toEqual(EXPECTED);
  });

  it('the what-if summary is the same answer', () => {
    expect(buildWhatifCtx(summaryState(), '2026-09', CLOCK).summary).toEqual(EXPECTED);
  });

  it('equals the query answers', () => {
    const s = summaryState();
    const bal = queryAnswer(s, 'balances', { lens: 'booked' }, CLOCK);
    const spend = queryAnswer(s, 'spending.month', { month: '2026-09' }, CLOCK);
    expect(buildMonthlyBriefingCtx(s, '2026-09', CLOCK).summary).toEqual({
      totalEnvelopeBalance: bal.totals.envelopes,
      totalAccountBalance: bal.totals.accounts,
      unallocated: bal.unallocated,
      spentThisMonth: spend.spent,
      plannedThisMonth: spend.planned,
    });
  });

  it('defaults the month to the clock\u2019s month', () => {
    const ctx = buildMonthlyBriefingCtx(summaryState(), undefined, CLOCK);
    expect(ctx.month).toBe('2026-09');
    expect(ctx.summary.spentThisMonth).toBe(40);
    expect(buildWhatifCtx(summaryState(), undefined, CLOCK).month).toBe('2026-09');
    expect(buildWhatifCtx(summaryState(), undefined, CLOCK).today).toBe('2026-09-15');
  });

  it('reads the clock once per build, whichever queries it runs', () => {
    for (const build of [buildMonthlyBriefingCtx, buildWhatifCtx]) {
      let reads = 0;
      build(summaryState(), undefined, () => { reads++; return CLOCK(); });
      expect(reads, build.name).toBe(1);
    }
  });

  it('has no clock of its own: a builder without one throws', () => {
    expect(() => buildMonthlyBriefingCtx(summaryState())).toThrow();
    expect(() => buildWhatifCtx(summaryState())).toThrow();
  });
});

describe('the what-if forecast reads the upcoming query', () => {
  // The old composition, copied from buildWhatifCtx before this change: the
  // forecast generators from today (no overdue rows), 90 days, deduped.
  function oldForecast(state, today) {
    const end = new Date(today.getTime() + 90 * 86_400_000);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const taken = takenOccurrenceKeys(state.transactions, state.meta?.scheduledTombstones);
    return forecastScheduledTransactions(
      state.budgetItems, state.accounts, state.envelopes, today, iso(end), iso(today),
      state.meta?.country ?? 'FI', { transactions: state.transactions },
    )
      .concat(forecastAllFills(state.budgetItems, state.envelopeTemplates, state.accounts, state.envelopes,
        today, iso(end), { fromDateStr: iso(today), country: state.meta?.country ?? 'FI' }))
      .filter((f) => !taken.has(forecastKey(f)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function planned() {
    const s = summaryState();
    s.accounts[0].initialBalance = 5000;
    s.budgetItems = [
      { id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'food', account_id: 'chk', as_schedule: true, payment_day: 20, default_amount: -80, include: true, monthly_schedule: ALL_MONTHS(-80) },
      { id: 'power', kind: 'expense', description: 'Power', envelope_id: 'food', account_id: 'chk', as_schedule: true, payment_day: 3, default_amount: -30, include: true, monthly_schedule: ALL_MONTHS(-30) },
    ];
    s.envelopeTemplates = [{
      id: 'tpl', name: 'Monthly', kind: 'manual',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: Object.fromEntries(Object.keys(ALL_MONTHS(0)).map((m) => [m, true])) },
    }];
    return s;
  }

  it('lists what the generators gave for a ledger with nothing overdue', () => {
    const s = planned();
    s.transactions = s.transactions.concat([
      // This month's earlier occurrences are posted, so none is overdue.
      { id: 'p-power', type: 'expense', status: 'posted', date: '2026-09-03', amount: 30, account: 'chk', envelope_id: 'food', from_budget: 'bi:power:2026-09' },
    ]);
    const expected = oldForecast(s, CLOCK());
    const got = buildWhatifCtx(s, '2026-09', CLOCK).forecast90d;
    expect(expected.length).toBeGreaterThan(5);
    expect(got.map((r) => [r.date, r.type, r.payee])).toEqual(
      expected.slice(0, 60).map((r) => [r.date, r.type, r.payee ?? null]),
    );
  });

  it('leaves out the overdue rows of this month, as it always did', () => {
    const s = planned();
    const dates = buildWhatifCtx(s, '2026-09', CLOCK).forecast90d.map((r) => r.date);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => d >= '2026-09-15')).toBe(true);
    // Power (day 3) fell due before the 15th and was never posted: overdue, not upcoming.
    expect(buildWhatifCtx(s, '2026-09', CLOCK).forecast90d.some((r) => r.date === '2026-09-03')).toBe(false);
    // Rent (day 20) is still ahead.
    expect(dates).toContain('2026-09-20');
  });

  it('keeps the slim row shape and a fill\u2019s own fields', () => {
    const rows = buildWhatifCtx(planned(), '2026-09', CLOCK).forecast90d;
    const rent = rows.find((r) => r.date === '2026-09-20');
    expect(rent).toEqual({ date: '2026-09-20', type: 'expense', amount: 80, envelope_id: 'food', account_id: 'chk', payee: 'Rent' });
    const fill = rows.find((r) => r.type === 'fill');
    expect(fill).toEqual({ date: '2026-10-01', type: 'fill', amount: 300, envelope_id: null, envelope_ids: ['food'], account_id: null, payee: fill.payee });
    expect(Object.keys(rent)).not.toContain('origin');
    expect(Object.keys(rent)).not.toContain('overdue');
  });
});

describe('currency stamping', () => {
  it('maps ISO codes to the symbol the model should print', () => {
    expect(currencySymbolFor('EUR')).toBe('€');
    expect(currencySymbolFor('USD')).toBe('$');
    expect(currencySymbolFor('GBP')).toBe('£');
    expect(currencySymbolFor('SEK')).toBe('kr');
  });

  it('falls back to the code, never silently to dollars', () => {
    expect(currencySymbolFor('XYZ')).toBe('XYZ');
    expect(currencySymbolFor(null)).toBe('€');
  });

  it('adds both the code and the symbol without touching the rest', () => {
    const ctx = withCurrency({ foo: 1, refs: { envelopes: [] } }, { meta: { currency: 'EUR' } });
    expect(ctx).toMatchObject({ foo: 1, currency: 'EUR', currency_symbol: '€' });
    expect(ctx.refs).toEqual({ envelopes: [] });
  });

  it('defaults to EUR when the budget names no currency', () => {
    expect(withCurrency({}, {})).toMatchObject({ currency: 'EUR', currency_symbol: '€' });
  });

  it('does not mutate the context it was given', () => {
    const original = { a: 1 };
    withCurrency(original, { meta: { currency: 'USD' } });
    expect(original).toEqual({ a: 1 });
  });

  it('carries the currency for every feature context the dispatcher builds', () => {
    // The bug was a euro budget being described in dollars because the model
    // was never told which currency it was looking at.
    const state = makeFixtureState();
    state.meta = { ...(state.meta || {}), currency: 'EUR' };
    for (const build of BUILDERS) {
      const ctx = withCurrency(build(state), state);
      expect(ctx.currency, build.name).toBe('EUR');
      expect(ctx.currency_symbol, build.name).toBe('€');
    }
  });
});
