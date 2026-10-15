// tests/core-query-plan-funding.test.js — `plan.funding`, every plan item's
// fill % as a query (it replaces js/state/item-funding-index.js).
//
// The old index is copied verbatim below (`oldIndex`, item-funding-index.js
// before this change, its memo left out). It projected only the envelopes that
// have plan items, so a set-mode template's target was missing from the walk
// when the target had none: the same bug 4d fixed on the Envelopes page. The
// query projects the funded envelopes against every active one, so each item
// equals its envelope's row in `envelopes.month` (what the Envelopes card and
// the health sheet show), and the old index's figures are pinned where the
// fix does not move them.
import { describe, it, expect, beforeEach } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import {
  computeEnvelopeBalances, computeSpareByEnvelope, computeItemFundingByEnvelope, envelopeFundingItems,
} from '../js/engine.js';
import { round2 } from '../js/utils.js';
import { state, FIXED_NOW } from './_fakes/pageApp.js';
import { seedEnvelopesBudget } from './_fakes/envelopesBudget.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const ctx = () => makeCtx({ now: new Date(FIXED_NOW), newId: () => 'x' });
const data = () => ({ ...state });
const ask = (name, input = {}, d = data()) => runQuery(registry, d, name, input, ctx());

// item-funding-index.js before this change, verbatim but for the memo.
function oldIndex(st, today) {
  const tombstones = st.meta?.scheduledTombstones || [];
  const country = st.meta?.country ?? 'FI';
  const budgetItems = st.budgetItems || [];
  const envelopes = (st.envelopes || []).filter(e => e && !e.archived
    && envelopeFundingItems(budgetItems, e.id).length > 0);
  const index = new Map();
  if (envelopes.length) {
    const spare = computeSpareByEnvelope({
      transactions: st.transactions, budgetItems, envelopeTemplates: st.envelopeTemplates,
      accounts: st.accounts, envelopes, today, months: 12, country, tombstones,
    });
    const byEnvelope = computeItemFundingByEnvelope({
      envelopes, budgetItems, transactions: st.transactions,
      balances: computeEnvelopeBalances(st.transactions, { asOf: today }),
      today, country, tombstones,
      dailyByEnvelope: new Map([...spare].map(([id, sp]) => [id, sp.daily])),
    });
    for (const [envelopeId, funding] of byEnvelope) {
      for (const item of funding.items) index.set(item.itemId, { ...item, envelopeId });
    }
  }
  return index;
}

// The query's money is round2'd; the old index's was not.
const MONEY = ['planThisMonth', 'spent', 'remaining', 'overspent', 'allocated', 'shortBy'];
const rounded = (i) => ({
  ...i,
  ...Object.fromEntries(MONEY.map(k => [k, round2(i[k])])),
  nextDue: i.nextDue ? { date: i.nextDue.date, amount: round2(i.nextDue.amount) } : null,
});
const pick = (i) => ({
  itemId: i.itemId, name: i.name, style: i.style, envelopeId: i.envelopeId, pct: i.pct, status: i.status,
  shortDate: i.shortDate, nextDue: i.nextDue, ...Object.fromEntries(MONEY.map(k => [k, i[k]])),
});

// Pays 900 from the savings pot (1,000) on the 20th. With the trip's set-mode
// top-up moved to the 16th (`topUpOn16th`), the pot pays 200 of it to bring
// the trip from 300 to 500 first, but only when the trip is part of the walk.
const savingsItem = {
  id: 'boat', kind: 'expense', envelope_id: 'savings', description: 'Boat', default_amount: -900, extra_buffer: 0,
  include: true, monthly_schedule: every(), as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact',
};

const topUpOn16th = () => {
  state.envelopeTemplates = state.envelopeTemplates.map(t => (t.id === 'tt' ? { ...t, schedule: { ...t.schedule, payment_day: 16 } } : t));
};

describe('plan.funding', () => {
  beforeEach(() => { seedEnvelopesBudget(); });

  it('equals the old index on the fixture, money in cents', () => {
    const r = ask('plan.funding');
    expect(r.ok).toBe(true);
    const expected = [...oldIndex(state, new Date(FIXED_NOW)).values()].map(rounded).map(pick);
    expect(expected.length).toBeGreaterThan(0);
    expect(r.value.items.map(pick)).toEqual(expected);
  });

  it('each item equals its envelope\'s funding row in envelopes.month', () => {
    state.budgetItems = [...state.budgetItems, savingsItem];
    topUpOn16th();
    const items = ask('plan.funding').value.items;
    const month = ask('envelopes.month', { lens: 'booked' }).value.envelopes;
    const rows = month.flatMap(e => (e.funding ? e.funding.items.map(i => ({ ...i, envelopeId: e.id })) : []));
    expect(items).toEqual(rows);
    expect(items.some(i => i.envelopeId === 'savings')).toBe(true);
  });

  it('the trip a funded pot tops up is in the walk: short by 100, where the old index said funded', () => {
    state.budgetItems = [...state.budgetItems, savingsItem];
    topUpOn16th();
    const boat = ask('plan.funding').value.items.find(i => i.itemId === 'boat');
    expect(boat).toMatchObject({ status: 'short', shortBy: 100, shortDate: '2026-09-20', envelopeId: 'savings' });
    expect(oldIndex(state, new Date(FIXED_NOW)).get('boat')).toMatchObject({ status: 'funded', shortBy: 0 });
    const card = ask('envelopes.month', { lens: 'booked' }).value.envelopes.find(e => e.id === 'savings');
    expect(card.funding.items.find(i => i.itemId === 'boat')).toMatchObject({ status: 'short', shortBy: 100 });
  });

  it('archived envelopes and envelopes without funded items have no rows', () => {
    const ids = new Set(ask('plan.funding').value.items.map(i => i.envelopeId));
    expect(ids.has('gone')).toBe(false);
    expect(ids.has('trip')).toBe(false);
  });

  it('nothing funded: no items', () => {
    state.budgetItems = [];
    expect(ask('plan.funding').value).toEqual({ items: [] });
  });

  it('answers the same object until something it reads is replaced', () => {
    const d = data();
    const a = ask('plan.funding', {}, d).value;
    expect(ask('plan.funding', {}, d).value).toBe(a);
    expect(ask('plan.funding', {}, { ...d, transactions: [...d.transactions] }).value).not.toBe(a);
    expect(ask('plan.funding', { date: '2026-09-16' }, d).value).not.toBe(a);
  });
});

describe('envelopes.month for a few envelopes (the Dashboard\'s favourites)', () => {
  beforeEach(() => { seedEnvelopesBudget(); });

  it('the savings pot alone has the figures it has in the full set', () => {
    state.budgetItems = [...state.budgetItems, savingsItem];
    topUpOn16th();
    const full = ask('envelopes.month', { lens: 'booked' }).value.envelopes.find(e => e.id === 'savings');
    const alone = ask('envelopes.month', { lens: 'booked', envelopes: ['savings'] }).value.envelopes;
    expect(alone).toEqual([full]);
    expect(full.funding.items[0]).toMatchObject({ itemId: 'boat', status: 'short' });
  });
});
