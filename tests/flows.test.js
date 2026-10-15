// Money flow (Sankey) data: the saving boundary split into saving and debt,
// and the plan / actual flow builders (js/engine/flows.js).
import { describe, it, expect } from 'vitest';
import { savingBoundary, txSavingFlow } from '../js/engine/reports.js';

const acc = {
  chk: { id: 'chk', type: 'checking' },
  sav: { id: 'sav', type: 'savings' },
  inv: { id: 'inv', type: 'investment' },
  loan: { id: 'loan', type: 'loan' },
  lent: { id: 'lent', type: 'loan_given' },
};
const accounts = Object.values(acc);
const byId = new Map(accounts.map(a => [a.id, a]));

describe('savingBoundary / txSavingFlow', () => {
  it('splits the saving boundary by the saving side', () => {
    expect(savingBoundary(acc.chk, acc.sav)).toEqual({ direction: 'in', bucket: 'saving' });
    expect(savingBoundary(acc.sav, acc.chk)).toEqual({ direction: 'out', bucket: 'saving' });
    expect(savingBoundary(acc.chk, acc.loan)).toEqual({ direction: 'in', bucket: 'debt' });
    expect(savingBoundary(acc.loan, acc.chk)).toEqual({ direction: 'out', bucket: 'debt' });
    expect(savingBoundary(acc.chk, acc.lent)).toEqual({ direction: 'in', bucket: 'saving' });
    expect(savingBoundary(acc.sav, acc.inv)).toBeNull();
    expect(savingBoundary(acc.chk, undefined)).toBeNull();
  });

  it('carries savingEffect’s signed amount', () => {
    expect(txSavingFlow({ type: 'debt_payment', amount: 300, from_account: 'chk', to_account: 'loan' }, byId))
      .toEqual({ bucket: 'debt', amount: 300 });
    expect(txSavingFlow({ type: 'account_transfer', amount: 50, from_account: 'sav', to_account: 'chk' }, byId))
      .toEqual({ bucket: 'saving', amount: -50 });
    expect(txSavingFlow({ type: 'expense', amount: 5, account: 'chk', envelope_id: 'e' }, byId)).toBeNull();
  });
});

// ── Flow builders ─────────────────────────────────────────────────────────

import { buildPlanFlow, buildActualFlow } from '../js/engine/flows.js';

const envelopes = [
  { id: 'rent', name: 'Rent', category: 'housing' },
  { id: 'groc', name: 'Groceries', category: 'food' },
  { id: 'out', name: 'Eating out', category: 'food' },
  { id: 'bare', name: 'Bare' },
];

const every = v => Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, v]));

const node = (flow, id) => flow.nodes.find(n => n.id === id);
const val = (flow, id) => node(flow, id)?.value;

/** Every middle node balances; sources = sinks = totals; links positive. */
function expectConserved(flow) {
  const inOf = new Map(), outOf = new Map();
  for (const l of flow.links) {
    expect(l.value).toBeGreaterThan(0);
    inOf.set(l.target, (inOf.get(l.target) || 0) + l.value);
    outOf.set(l.source, (outOf.get(l.source) || 0) + l.value);
  }
  for (const n of flow.nodes) {
    const i = inOf.get(n.id) || 0, o = outOf.get(n.id) || 0;
    expect(i + o).toBeGreaterThan(0);
    if (i && o) expect(i).toBeCloseTo(o, 2);
    expect(n.value).toBeCloseTo(Math.max(i, o), 2);
  }
  const sources = flow.nodes.filter(n => !inOf.has(n.id)).reduce((s, n) => s + n.value, 0);
  const sinks = flow.nodes.filter(n => !outOf.has(n.id)).reduce((s, n) => s + n.value, 0);
  expect(sources).toBeCloseTo(flow.totals.in, 2);
  expect(sinks).toBeCloseTo(flow.totals.out, 2);
  expect(flow.totals.in).toBeCloseTo(flow.totals.out, 2);
}

const planItems = [
  { id: 'sal', kind: 'income', description: 'Salary', default_amount: 3000, monthly_schedule: every(true), account_id: 'chk' },
  { id: 'r', kind: 'expense', envelope_id: 'rent', default_amount: -1000, monthly_schedule: every(true) },
  { id: 'g', kind: 'expense', envelope_id: 'groc', default_amount: -400, monthly_schedule: every(true), extra_buffer: 100 },
  { id: 'b', kind: 'investment_transfer', direction: 'buy', default_amount: -200, monthly_schedule: every(true),
    account_id: 'chk', investment_account_id: 'inv', envelope_id: 'groc' },
  { id: 'l', kind: 'loan_payment', default_amount: -300, monthly_schedule: every(true), account_id: 'chk', to_account_id: 'loan', envelope_id: 'rent' },
  { id: 'x', kind: 'expense', envelope_id: 'out', default_amount: -50, monthly_schedule: every(true), include: false },
];

describe('buildPlanFlow', () => {
  it('year: income → categories, saving, debt and the rest unspent', () => {
    const f = buildPlanFlow(planItems, envelopes, accounts, { period: 'year' });
    expect(val(f, 'src:Salary')).toBe(36000);
    expect(val(f, 'budget')).toBe(36000);
    expect(val(f, 'cat:housing')).toBe(12000);
    expect(val(f, 'cat:food')).toBe(4900); // 400×12 + the 100 buffer
    expect(val(f, 'saving')).toBe(2400);
    expect(val(f, 'debt')).toBe(3600);
    expect(val(f, 'unspent')).toBe(36000 - 12000 - 4900 - 2400 - 3600);
    expect(node(f, 'cat:out')).toBeUndefined(); // excluded item
    expect(node(f, 'env:groc')).toMatchObject({ key: 'groc', category: 'food', column: 3 });
    expectConserved(f);
  });

  it('month: that month only, no buffer', () => {
    const items = [...planItems, { id: 'bonus', kind: 'income', description: 'Bonus', default_amount: 500, monthly_schedule: { Dec: 1500 } }];
    const nov = buildPlanFlow(items, envelopes, accounts, { period: 'month', month: '2026-11' });
    expect(node(nov, 'src:Bonus')).toBeUndefined();
    expect(val(nov, 'cat:food')).toBe(400);
    const dec = buildPlanFlow(items, envelopes, accounts, { period: 'month', month: '2026-12' });
    expect(val(dec, 'src:Bonus')).toBe(1500);
    expectConserved(dec);
  });

  it('a transfer out of savings is a source; outflow beyond income is a shortfall', () => {
    const items = [
      { kind: 'income', description: 'Salary', default_amount: 1000, monthly_schedule: { Jan: true } },
      { kind: 'expense', envelope_id: 'rent', default_amount: -1500, monthly_schedule: { Jan: true } },
      { kind: 'account_transfer', default_amount: -200, monthly_schedule: { Jan: true }, account_id: 'sav', to_account_id: 'chk' },
    ];
    const f = buildPlanFlow(items, envelopes, accounts, { period: 'month', month: '2026-01' });
    expect(val(f, 'fromSavings')).toBe(200);
    expect(val(f, 'shortfall')).toBe(300);
    expect(node(f, 'unspent')).toBeUndefined();
    expect(f.nodes.filter(n => n.column === 0).map(n => n.id)).toEqual(['src:Salary', 'fromSavings', 'shortfall']);
    expectConserved(f);
  });

  it('a transfer that does not cross the boundary does not appear', () => {
    const items = [
      { kind: 'income', description: 'Salary', default_amount: 1000, monthly_schedule: { Jan: true } },
      { kind: 'account_transfer', default_amount: -200, monthly_schedule: { Jan: true }, account_id: 'sav', to_account_id: 'inv' },
    ];
    const f = buildPlanFlow(items, envelopes, accounts, { period: 'month', month: '2026-01' });
    expect(val(f, 'unspent')).toBe(1000);
    expect(node(f, 'saving')).toBeUndefined();
  });

  it('requires a period', () => {
    expect(() => buildPlanFlow(planItems, envelopes, accounts, /** @type {any} */ (undefined))).toThrow();
    expect(() => buildPlanFlow(planItems, envelopes, accounts, { period: 'month', month: '2026' })).toThrow();
  });
});

describe('buildActualFlow', () => {
  const txs = [
    { id: '1', type: 'income', date: '2026-09-01', amount: 3000, payee: 'Employer', account: 'chk' },
    { id: '2', type: 'income', date: '2026-09-15', amount: 200, payee: 'Side gig', account: 'chk' },
    { id: '3', type: 'expense', date: '2026-09-02', amount: 900, account: 'chk', envelope_id: 'rent', payee: 'Landlord' },
    { id: '4', type: 'expense', date: '2026-09-03', amount: 120, account: 'chk', payee: 'Shop',
      envelope_splits: [{ envelope_id: 'groc', amount: 100 }, { envelope_id: 'out', amount: 20 }] },
    { id: '5', type: 'investment_transfer', direction: 'buy', date: '2026-09-04', amount: 500, from_account: 'chk', to_account: 'inv', envelope_id: 'groc' },
    { id: '6', type: 'debt_payment', date: '2026-09-05', amount: 300, from_account: 'chk', to_account: 'loan', envelope_id: 'rent' },
    { id: '7', type: 'account_transfer', date: '2026-09-06', amount: 800, from_account: 'sav', to_account: 'chk' },
    { id: '8', type: 'account_transfer', date: '2026-09-07', amount: 1000, from_account: 'loan', to_account: 'chk' },
    { id: '9', type: 'expense', date: '2026-08-31', amount: 999, account: 'chk', envelope_id: 'rent' },
    { id: '10', type: 'expense', date: '2026-09-20', amount: 50, account: 'chk', envelope_id: 'rent', status: 'scheduled' },
  ];
  const range = { from: '2026-09-01', to: '2026-09-30' };

  it('income by payee; spending by envelope; saving and debt nets', () => {
    const f = buildActualFlow(txs, accounts, envelopes, range);
    expect(val(f, 'src:Employer')).toBe(3000);
    expect(val(f, 'src:Side gig')).toBe(200);
    expect(val(f, 'env:rent')).toBe(900);      // not the loan principal, not out-of-range or scheduled rows
    expect(val(f, 'env:groc')).toBe(100);      // the buy is saving, not spending
    expect(val(f, 'env:out')).toBe(20);
    expect(node(f, 'saving')).toBeUndefined(); // +500 buy − 800 withdrawn = −300
    expect(val(f, 'fromSavings')).toBe(300);
    expect(node(f, 'debt')).toBeUndefined();   // +300 repaid − 1000 drawn = −700
    expect(val(f, 'borrowed')).toBe(700);
    expect(val(f, 'unspent')).toBe(3200 + 300 + 700 - 1020);
    expectConserved(f);
  });

  it('leaves excluded envelopes out of spending', () => {
    const f = buildActualFlow(txs, accounts, envelopes, range, { excludeEnvelopes: new Set(['rent']) });
    expect(node(f, 'env:rent')).toBeUndefined();
    expect(node(f, 'cat:housing')).toBeUndefined();
    expect(val(f, 'unspent')).toBe(3200 + 300 + 700 - 120);
    expectConserved(f);
  });

  it('a positive saving and debt net are sinks', () => {
    const f = buildActualFlow(txs.filter(t => t.id !== '7' && t.id !== '8'), accounts, envelopes, range);
    expect(val(f, 'saving')).toBe(500);
    expect(val(f, 'debt')).toBe(300);
    expectConserved(f);
  });

  it('folds sources and envelopes beyond the top N', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ type: 'income', date: '2026-09-01', amount: 100 + i, payee: `P${i}`, account: 'chk' }));
    const envs = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, category: 'misc' }));
    const spend = envs.map((e, i) => ({ type: 'expense', date: '2026-09-02', amount: 10 + i, account: 'chk', envelope_id: e.id }));
    const f = buildActualFlow([...many, ...spend], accounts, envs, range);
    expect(f.nodes.filter(n => n.kind === 'source').length).toBe(9);
    expect(node(f, 'src:other')).toMatchObject({ other: 2, value: 201 });
    expect(node(f, 'env-other:misc')).toMatchObject({ other: 2, key: null, value: 21 });
    expectConserved(f);
    const all = buildActualFlow([...many, ...spend], accounts, envs, range, { topPerCategory: Infinity });
    expect(all.nodes.filter(n => n.kind === 'envelope').length).toBe(8);
  });

  it('a fold of a single row is not folded', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ type: 'income', date: '2026-09-01', amount: 100 + i, payee: `P${i}`, account: 'chk' }));
    const f = buildActualFlow(nine, accounts, envelopes, range);
    expect(node(f, 'src:other')).toBeUndefined();
    expect(f.nodes.filter(n => n.kind === 'source').length).toBe(9);
  });

  it('nothing in range is an empty flow', () => {
    const f = buildActualFlow(txs, accounts, envelopes, { from: '2030-01-01', to: '2030-01-31' });
    expect(f.totals).toEqual({ in: 0, out: 0 });
    expect(f.links).toEqual([]);
  });

  it('an envelope with no category lands in "other"; an unknown envelope too', () => {
    const f = buildActualFlow([
      { type: 'income', date: '2026-09-01', amount: 100, payee: 'X', account: 'chk' },
      { type: 'expense', date: '2026-09-02', amount: 10, account: 'chk', envelope_id: 'bare' },
      { type: 'expense', date: '2026-09-02', amount: 5, account: 'chk', envelope_id: 'ghost' },
    ], accounts, envelopes, range);
    expect(node(f, 'env:bare')).toMatchObject({ category: 'other', label: 'Bare' });
    expect(node(f, 'env:ghost')).toMatchObject({ category: 'other', label: null });
    expect(val(f, 'cat:other')).toBe(15);
    expectConserved(f);
  });

  it('counts posted rows only', () => {
    const f = buildActualFlow([
      { type: 'income', date: '2026-09-01', amount: 100, payee: 'X', account: 'chk' },
      { type: 'income', date: '2026-09-02', amount: 900, payee: 'Y', account: 'chk', status: 'scheduled' },
      { type: 'account_transfer', date: '2026-09-02', amount: 50, from_account: 'chk', to_account: 'sav', is_forecast: true },
    ], accounts, envelopes, range);
    expect(node(f, 'src:Y')).toBeUndefined();
    expect(node(f, 'saving')).toBeUndefined();
    expect(f.totals.in).toBe(100);
  });

  it('requires a range', () => {
    expect(() => buildActualFlow(txs, accounts, envelopes, /** @type {any} */ (undefined))).toThrow();
  });
});

it('draws a net envelope refund as a source, conserving the returned money', () => {
  const f = buildActualFlow([{ id: 'r', type: 'expense', amount: 50, date: '2026-10-01', account: 'chk', envelope_splits: [{ envelope_id: 'groc', amount: -50 }, { envelope_id: 'rent', amount: 100 }] }], accounts, envelopes, { from: null, to: null });
  expect(node(f, 'refund:groc')).toMatchObject({ column: 0, kind: 'envelope', value: 50, key: 'groc' });
  expect(val(f, 'shortfall')).toBe(50);
  expect(val(f, 'env:rent')).toBe(100);
  expectConserved(f);
});
