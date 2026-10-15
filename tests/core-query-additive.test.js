// tests/core-query-additive.test.js — what the 4c pages and the AI need from
// queries that already exist, added without changing their answers otherwise:
// `balances { asOf }` (the reconcile context's expected balance, against
// computeAccountBalancesAsOf as js/ai/context-builder.js L478 reads it),
// `envelopes.month { spare: false }` (no projection) and its per-row `buffer`
// (against computeBufferByEnvelope over the dated plan, as the AI's envelope
// health builder reads it), and the Review page's sums in `review.month`:
// `pageReviewSums` copies js/pages/review.js verbatim (the grouping L372-380,
// footer totals L385-396, consolidateDelta L424, the category subtotals
// L448-459, the negative count L548, the popover's available L581 and the
// detail section total L152), fed the query's own rows as the page is.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { computeAccountBalancesAsOf, computeEnvelopeBalances, computeUnallocated, computeBufferByEnvelope, planItemsAsOf, monthStartDate } from '../js/engine.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
const NOW = new Date(2026, 8, 15, 10, 0, 0);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
// Rows dated across August and September, one in October; an archived
// account and envelope; a plan with buffers, one item ended in June.
const data = () => deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 },
    { id: 'card', name: 'Card', type: 'credit_card' },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 5000 },
    { id: 'old', name: 'Old', type: 'savings', archived: true, initialBalance: 10.555 },
  ],
  envelopes: [
    { id: 'food', name: 'Food', category: 'Living' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'gone', name: 'Gone', category: 'Misc', archived: true },
  ],
  budgetItems: [
    { id: 'i-food', kind: 'expense', envelope_id: 'food', default_amount: -300, include: true, monthly_schedule: ALL_MONTHS, extra_buffer: 150 },
    { id: 'i-food2', kind: 'expense', envelope_id: 'food', default_amount: -20, include: true, monthly_schedule: ALL_MONTHS, extra_buffer: -25.5 },
    { id: 'i-rent', kind: 'expense', envelope_id: 'rent', default_amount: -900, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'i-ended', kind: 'expense', envelope_id: 'rent', default_amount: -50, include: true, monthly_schedule: ALL_MONTHS, extra_buffer: 400, end_month: '2026-06' },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'inc', type: 'income', date: '2026-08-01', amount: 2500, account: 'chk', status: 'posted' },
    { id: 'fill', type: 'fill', date: '2026-08-01', status: 'posted', lines: [{ envelope_id: 'food', amount: 400 }, { envelope_id: 'rent', amount: 900 }, { envelope_id: 'gone', amount: 12.345 }] },
    { id: 'e1', type: 'expense', date: '2026-08-31', amount: 55.25, account: 'card', envelope_id: 'food', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-09-01', amount: 900, account: 'chk', envelope_id: 'rent', status: 'posted' },
    { id: 'e3', type: 'expense', date: '2026-09-20', amount: 30, account: 'chk', envelope_id: 'food', status: 'scheduled' },
    { id: 'e4', type: 'expense', date: '2026-10-02', amount: 12.5, account: 'card', envelope_id: 'food', status: 'posted' },
  ],
});

// ── balances { asOf } ──────────────────────────────────────────────────────

describe('balances asOf — the booked balances at the end of a day', () => {
  for (const asOf of ['2026-07-31', '2026-08-31', '2026-09-01', '2026-09-30', '2026-12-31']) {
    it(`as of ${asOf}: computeAccountBalancesAsOf, the envelope balances and unallocated on the same day`, () => {
      const d = data();
      const a = answer('balances', { lens: 'booked', asOf, includeArchived: true }, d);
      jsonSafe(a);
      const acc = computeAccountBalancesAsOf(d.accounts, d.transactions, asOf);
      const env = computeEnvelopeBalances(d.transactions, { asOf });
      expect(a.accounts.map(x => [x.id, x.balance])).toEqual(d.accounts.map(x => [x.id, round2(acc.get(x.id) ?? 0)]));
      expect(a.envelopes.map(x => [x.id, x.balance])).toEqual(d.envelopes.map(x => [x.id, round2(env.get(x.id) ?? 0)]));
      expect(a.unallocated).toBe(computeUnallocated(acc, env, d.accounts));
      // The reconcile context's expected balance (context-builder.js L478).
      expect(a.accounts.find(x => x.id === 'chk').balance).toBe(round2(computeAccountBalancesAsOf(d.accounts, d.transactions, asOf).get('chk') || 0));
    });
  }

  it('the rows after the day are left out; without asOf, nothing changes', () => {
    const d = data();
    const aug = answer('balances', { lens: 'booked', asOf: '2026-08-31' }, d);
    expect(aug.accounts.map(x => [x.id, x.balance])).toEqual([['chk', 3500], ['card', -55.25], ['inv', 5000]]);
    expect(aug.envelopes.map(x => [x.id, x.balance])).toEqual([['food', 344.75], ['rent', 900]]);
    const all = answer('balances', { lens: 'booked' }, d);
    expect(all.accounts.map(x => [x.id, x.balance])).toEqual([['chk', 2570], ['card', -67.75], ['inv', 5000]]);
    expect(all).not.toHaveProperty('asOf');
  });

  it('only with the booked lens', () => {
    const d = data();
    for (const lens of ['today', 'forecast']) {
      expect(ask('balances', { lens, asOf: '2026-08-31' }, d).error).toEqual({
        code: 'bad_input', params: { errors: [{ path: 'asOf', message: 'only allowed with lens booked' }] },
      });
    }
    expect(ask('balances', { lens: 'booked', asOf: '2026-02-30' }, d).error.code).toBe('bad_input');
  });
});

// ── envelopes.month { spare: false } ───────────────────────────────────────

describe('envelopes.month spare false — no projection', () => {
  it('every other figure as with spare, every spare and funding null', () => {
    const d = data();
    for (const input of [{}, { envelopes: ['gone', 'food'] }, { lens: 'forecast', horizon: 'eom' }, { date: '2026-08-20' }]) {
      const withSpare = answer('envelopes.month', input, d);
      const without = answer('envelopes.month', { ...input, spare: false }, d);
      jsonSafe(without);
      expect(withSpare.envelopes.some(e => e.spare !== null)).toBe(true);
      // Funding is judged against the spare walk: without it, null too.
      expect(without).toEqual({ ...withSpare, envelopes: withSpare.envelopes.map(e => ({ ...e, spare: null, funding: null })) });
    }
  });

  it('spare true is the default', () => {
    const d = data();
    expect(answer('envelopes.month', { spare: true }, d)).toEqual(answer('envelopes.month', {}, d));
  });
});

// ── envelopes.month buffer ─────────────────────────────────────────────────

describe('envelopes.month buffer — the dated plan\'s extra buffer', () => {
  for (const date of ['2026-09-15', '2026-05-10', '2026-09-01']) {
    it(`on ${date}: computeBufferByEnvelope(planItemsAsOf(items, date))`, () => {
      const d = data();
      const [y, m, day] = date.split('-').map(Number);
      const buffers = computeBufferByEnvelope(planItemsAsOf(d.budgetItems, new Date(y, m - 1, day, 12)));
      const a = answer('envelopes.month', { date, envelopes: ['food', 'rent', 'gone'], spare: false }, d);
      expect(a.envelopes.map(e => [e.id, e.buffer])).toEqual(['food', 'rent', 'gone'].map(id => [id, round2(buffers.get(id) || 0)]));
    });
  }

  it('worked: |150| + |−25.5| for food; the item ended in June counts only before July', () => {
    const d = data();
    const sep = answer('envelopes.month', { spare: false }, d);
    expect(sep.envelopes.map(e => [e.id, e.buffer])).toEqual([['food', 175.5], ['rent', 0]]);
    const may = answer('envelopes.month', { date: '2026-05-10', spare: false }, d);
    expect(may.envelopes.map(e => [e.id, e.buffer])).toEqual([['food', 175.5], ['rent', 400]]);
  });

  it('the envelope health builder\'s figure, with date the month\'s first day', () => {
    const d = data();
    const buffers = computeBufferByEnvelope(planItemsAsOf(d.budgetItems, monthStartDate('2026-06')));
    const a = answer('envelopes.month', { date: '2026-06-01', spare: false }, d);
    expect(a.envelopes.map(e => [e.id, e.buffer])).toEqual([['food', round2(buffers.get('food') || 0)], ['rent', round2(buffers.get('rent') || 0)]]);
    expect(a.envelopes.find(e => e.id === 'rent').buffer).toBe(400);
  });
});

// ── review.month: the page's sums ──────────────────────────────────────────

const REVIEW_NOW = new Date(2026, 9, 10, 14, 30, 0);
// Today is 10 Oct 2026. Two categories with two envelopes each, one envelope
// overspent (a negative balance), a planned item partly spent, a scheduled
// row before today (overdue) with a negative stored amount, one dated ahead
// (future), a split and a fill in the month, and a September set fill so the
// booked all-rows balance differs from the as-of-now one.
const reviewData = ({ withEmergency = false } = {}) => deepFreeze({
  meta: { country: 'FI', ...(withEmergency ? { emergency_envelope_id: 'emerg', emergency_duration_months: 3 } : {}) },
  accounts: [{ id: 'chk', name: 'Checking', type: 'checking', initialBalance: 5000 }],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'net', name: 'Internet', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'cafe', name: 'Cafe', category: 'Food' },
    { id: 'emerg', name: 'Emergency', category: 'Savings' },
    { id: 'old', name: 'Old', category: 'Misc', archived: true },
  ],
  budgetItems: [
    { id: 'rentItem', kind: 'expense', envelope_id: 'rent', account_id: 'chk', default_amount: -1000, payment_day: 25, schedule_day_type: 'exact',
      include: true, as_schedule: true, as_schedule_since: '2026-01-01', monthly_schedule: ALL_MONTHS, include_in_emergency_budget: true },
    { id: 'grocItem', kind: 'expense', envelope_id: 'groc', default_amount: -600, include: true, monthly_schedule: ALL_MONTHS, extra_buffer: 100,
      include_in_emergency_budget: true },
    { id: 'cafeItem', kind: 'expense', envelope_id: 'cafe', default_amount: -33.33, include: true, monthly_schedule: ALL_MONTHS },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'fill9', type: 'fill', date: '2026-09-01', status: 'posted',
      lines: [{ envelope_id: 'rent', amount: 2100 }, { envelope_id: 'net', amount: 100.1 }, { envelope_id: 'groc', amount: 1050 }, { envelope_id: 'emerg', amount: 1500 }] },
    { id: 'cafeSet', type: 'fill', date: '2026-09-02', status: 'posted', lines: [{ envelope_id: 'cafe', mode: 'set', amount: 20 }] },
    { id: 'rent9', type: 'expense', date: '2026-09-25', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'posted', from_budget: 'rentItem:2026-09' },
    { id: 'groc9', type: 'expense', date: '2026-09-15', payee: 'Shop', amount: 580.2, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'net10', type: 'expense', date: '2026-10-01', payee: 'ISP', amount: 140.15, account: 'chk', envelope_id: 'net', status: 'posted' },
    { id: 'cafe10', type: 'expense', date: '2026-10-04', payee: 'Cafe', amount: 45.45, account: 'chk', envelope_id: 'cafe', status: 'posted' },
    { id: 'groc10a', type: 'expense', date: '2026-10-03', payee: 'Shop', amount: 150.35, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'fillG', type: 'fill', date: '2026-10-05', status: 'posted', lines: [{ envelope_id: 'groc', amount: 30 }] },
    { id: 'groc10s', type: 'expense', date: '2026-10-08', payee: 'Market', amount: -25.1, account: 'chk', envelope_id: 'groc', status: 'scheduled' },
    { id: 'groc10f', type: 'expense', date: '2026-10-20', payee: 'Shop ahead', amount: 60.4, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'split10', type: 'expense', date: '2026-10-02', payee: 'Split', amount: 30, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'groc', amount: 20 }, { envelope_id: 'net', amount: 10 }] },
  ],
});

/**
 * @param {any} state
 * @param {any[]} rows  the query's rows, as the page reads them
 */
function pageReviewSums(state, rows) {
  // ── copied: L372-380 ──
  const categories = [];
  const byCategory = {};
  for (const row of rows) {
    if (!byCategory[row.category]) {
      byCategory[row.category] = [];
      categories.push(row.category);
    }
    byCategory[row.category].push(row);
  }
  // ── copied: L385-396 ──
  const totals = rows.reduce((acc, r) => {
    acc.balance   += r.balance;
    acc.actual    += r.actual;
    acc.scheduled += r.scheduled;
    acc.planned   += r.planned;
    acc.projected += r.projected;
    acc.D         += r.D;
    acc.required  += r.required;
    acc.startNext += r.startNext;
    acc.surplus   += r.surplus;
    return acc;
  }, { balance: 0, actual: 0, scheduled: 0, planned: 0, projected: 0, D: 0, required: 0, startNext: 0, surplus: 0 });
  const catTotalsList = [];
  for (const cat of categories) {
    const catRows = byCategory[cat];
    // ── copied: L448-459 ──
    const catTotals = catRows.reduce((acc, r) => {
      acc.balance   += r.balance;
      acc.actual    += r.actual;
      acc.scheduled += r.scheduled;
      acc.planned   += r.planned;
      acc.projected += r.projected;
      acc.D         += r.D;
      acc.required  += r.required;
      acc.startNext += r.startNext;
      acc.surplus   += r.surplus;
      return acc;
    }, { balance:0, actual:0, scheduled:0, planned:0, projected:0, D:0, required:0, startNext:0, surplus:0 });
    catTotalsList.push({ category: cat, totals: catTotals });
  }
  // ── copied: L424 ──
  const consolidateDeltas = rows.map(row => Math.round(-row.surplus * 100) / 100);
  // ── copied: L548 ──
  const negative = rows.filter(r => r.balance < -0.005).length;
  // ── copied: L581 ──
  const availables = rows.map(row => {
    const envelopeId = row.envelope_id;
    return computeEnvelopeBalances(state.transactions).get(envelopeId) ?? 0;
  });
  return { totals, catTotalsList, consolidateDeltas, negative, availables };
}
// copied: buildDetailSection L152
const pageSectionTotal = (rows) => rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);

const round2Each = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]));
const REVIEW_KEYS = ['balance', 'actual', 'scheduled', 'planned', 'projected', 'D', 'required', 'startNext', 'surplus'];

describe('review.month — the page\'s sums', () => {
  const cases = [
    ['a past month', '2026-09', {}],
    ['the current month', '2026-10', {}],
    ['a future month', '2026-12', {}],
    ['the current month with an emergency envelope', '2026-10', { withEmergency: true }],
  ];
  for (const [label, month, opts] of cases) {
    it(label, () => {
      const d = reviewData(opts);
      const a = answer('review.month', { month }, d, REVIEW_NOW);
      jsonSafe(a);
      const page = pageReviewSums(d, a.rows);
      expect(a.rows.length).toBeGreaterThan(0);
      expect(Object.keys(a.totals)).toEqual(REVIEW_KEYS);
      expect(a.totals).toEqual(round2Each(page.totals));
      expect(a.categoryTotals).toEqual(page.catTotalsList.map(c => ({ category: c.category, totals: round2Each(c.totals) })));
      expect(a.rows.map(r => r.consolidateDelta)).toEqual(page.consolidateDeltas);
      expect(a.rows.map(r => r.available)).toEqual(page.availables.map(round2));
      expect(a.negativeCount).toBe(page.negative);
    });
  }

  it('worked: categories in row order, an overspent envelope, the booked available', () => {
    const a = answer('review.month', { month: '2026-10' }, reviewData(), REVIEW_NOW);
    expect(a.categoryTotals.map(c => c.category)).toEqual(['Food', 'Housing', 'Savings']);
    const row = (id) => a.rows.find(r => r.envelope_id === id);
    // Internet: 100.1 − 140.15 − 10 is below zero.
    expect(row('net').balance).toBeLessThan(-0.005);
    expect(a.negativeCount).toBe(a.rows.filter(r => r.balance < -0.005).length);
    expect(a.negativeCount).toBeGreaterThan(0);
    // Groceries' available counts the posted row dated ahead; its balance does not.
    expect(row('groc').available).toBe(round2(1050 - 580.2 - 150.35 + 30 - 20 - 25.1 - 60.4));
    expect(row('groc').available).not.toBe(round2(row('groc').balance));
    expect(row('groc').consolidateDelta).toBe(Math.round(-row('groc').surplus * 100) / 100);
  });

  it('an envelope without a category groups under null, which survives JSON', () => {
    const d = reviewData();
    const loose = deepFreeze({
      ...d,
      envelopes: [...d.envelopes, { id: 'loose', name: 'Loose' }],
      transactions: [...d.transactions, { id: 'fillL', type: 'fill', date: '2026-10-02', status: 'posted', lines: [{ envelope_id: 'loose', amount: 40 }] }],
    });
    const a = answer('review.month', { month: '2026-10' }, loose, REVIEW_NOW);
    jsonSafe(a);
    const row = a.rows.find(r => r.envelope_id === 'loose');
    expect(row.category).toBeNull();
    const group = a.categoryTotals.find(c => c.category === null);
    expect(group).toBeDefined();
    expect(group.totals.balance).toBe(40);
    expect(JSON.parse(JSON.stringify(a.categoryTotals))).toEqual(a.categoryTotals);
  });

  it('detail: each section\'s total, the rows\' stored amounts unsigned (a split counts whole)', () => {
    const d = reviewData();
    const a = answer('review.month', { month: '2026-10', envelope: 'groc' }, d, REVIEW_NOW);
    const { detail } = a;
    expect(detail.totals).toEqual({
      actual: round2(pageSectionTotal(detail.actual)),
      overdue: round2(pageSectionTotal(detail.overdue)),
      coming: round2(pageSectionTotal(detail.coming)),
      future: round2(pageSectionTotal(detail.future)),
    });
    expect(detail.actual.map(t => t.id)).toEqual(['split10', 'groc10a']);
    // The split's whole 30, as the page sums r.amount; the overdue row's −25.1 unsigned.
    expect(detail.totals.actual).toBe(180.35);
    expect(detail.totals.overdue).toBe(25.1);
    expect(detail.totals.future).toBe(60.4);
    expect(detail.totals.coming).toBeGreaterThan(0);
    const none = answer('review.month', { month: '2026-10', envelope: 'emerg' }, d, REVIEW_NOW);
    expect(none.detail.totals).toEqual({ actual: 0, overdue: 0, coming: 0, future: 0 });
  });
});
