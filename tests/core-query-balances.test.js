import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions } from '../js/engine/lens.js';
import { computeAccountBalances, computeEnvelopeBalances, computeUnallocated, identityAccountTotal } from '../js/engine/balances.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `q${++n}`; })() });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

// chk 1000: a posted expense, a posted fill, a future-dated expense (Oct 20)
// and a scheduled expense. The rent item (Oct 25, planned) and the template
// (add 30 on the 28th) only exist in the forecast lens.
const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 },
    { id: 'old', name: 'Old savings', type: 'savings', initialBalance: 25.555, archived: true },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 200 },
  ],
  envelopes: [
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'gone', name: 'Gone', category: 'Misc', archived: true },
  ],
  budgetItems: [{
    id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
    default_amount: -100, payment_day: 25, schedule_day_type: 'exact', include: true,
    as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
  }],
  envelopeTemplates: [{
    id: 'tpl', name: 'Month end', kind: 'manual',
    lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }],
    schedule: { enabled: true, payment_day: 28, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS },
  }],
  transactions: [
    { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 300, lines: [{ envelope_id: 'groc', amount: 300 }], status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'A', amount: 100, account: 'chk', envelope_id: 'groc', cleared: true, status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-10-20', payee: 'B', amount: 40, account: 'chk', envelope_id: 'groc', cleared: true, status: 'posted' },
    { id: 'e3', type: 'expense', date: '2026-09-30', payee: 'C', amount: 10.5, account: 'sav', envelope_id: 'groc', cleared: false, status: 'scheduled' },
  ],
  ...extra,
});
const ask = (input, d = data()) => runQuery(registry, d, 'balances', input, ctx());

// What the status bar and the Accounts page compute today, spelled out.
function appComposition(d, opts) {
  const txs = lensTransactions(d, { ...opts, today: NOW });
  const acc = computeAccountBalances(d.accounts, txs);
  const env = computeEnvelopeBalances(txs);
  return { acc, env, unallocated: computeUnallocated(acc, env, d.accounts) };
}
const balanceOf = (list, id) => list.find(r => r.id === id)?.balance;

describe('balances query', () => {
  for (const [label, input, opts] of [
    ['booked', { lens: 'booked' }, { lens: 'booked' }],
    ['today', { lens: 'today' }, { lens: 'today' }],
    ['forecast (default horizon)', { lens: 'forecast' }, { lens: 'forecast' }],
    ['forecast eom', { lens: 'forecast', horizon: 'eom' }, { lens: 'forecast', horizon: 'eom' }],
    ['forecast 6m', { lens: 'forecast', horizon: '6m' }, { lens: 'forecast', horizon: '6m' }],
  ]) {
    it(`${label} equals the app's composition over the lens`, () => {
      const d = data();
      const r = ask(input, d);
      expect(r.ok).toBe(true);
      const { acc, env, unallocated } = appComposition(d, opts);
      const a = r.value;
      expect(a.accounts.map(x => x.id)).toEqual(['chk', 'sav']);
      for (const row of a.accounts) expect(row.balance).toBe(round2(acc.get(row.id) ?? 0));
      expect(a.envelopes.map(x => x.id)).toEqual(['groc', 'rent']);
      for (const row of a.envelopes) expect(row.balance).toBe(round2(env.get(row.id) ?? 0));
      expect(a.unallocated).toBe(unallocated);
      expect(a.lens).toBe(opts.lens);
    });
  }

  it('today differs from booked when a future-dated row exists', () => {
    const today = ask({ lens: 'today' }).value;
    const booked = ask({ lens: 'booked' }).value;
    // e2 (20 Oct) and the scheduled e3 count in booked, not in today.
    expect(balanceOf(booked.accounts, 'chk')).toBe(860);
    expect(balanceOf(today.accounts, 'chk')).toBe(900);
    expect(balanceOf(booked.accounts, 'sav')).toBe(189.5);
    expect(balanceOf(today.accounts, 'sav')).toBe(200);
    expect(today.horizon).toBeNull();
    expect(booked.horizon).toBeNull();
  });

  it('forecast with horizon eom includes a generated occurrence', () => {
    const d = data();
    const booked = ask({ lens: 'booked' }, d).value;
    const fc = ask({ lens: 'forecast', horizon: 'eom' }, d).value;
    expect(fc.horizon).toBe('2026-10-31');
    // The 25 Oct rent (-100) and the 28 Oct template fill (+30) are generated.
    expect(balanceOf(fc.accounts, 'chk')).toBe(round2(balanceOf(booked.accounts, 'chk') - 100));
    expect(balanceOf(fc.envelopes, 'rent')).toBe(-100);
    expect(balanceOf(fc.envelopes, 'groc')).toBe(round2(balanceOf(booked.envelopes, 'groc') + 30));
  });

  it('resolves the default and preset horizons to an ISO date', () => {
    expect(ask({ lens: 'forecast' }).value.horizon).toBe('2027-01-31');
    expect(ask({ lens: 'forecast', horizon: '3m' }).value.horizon).toBe('2027-01-31');
    expect(ask({ lens: 'forecast', horizon: '12m' }).value.horizon).toBe('2027-10-31');
    expect(ask({ lens: 'forecast', horizon: '2026-12-15' }).value.horizon).toBe('2026-12-15');
  });

  it('lists accounts and envelopes in array order with their fields', () => {
    const a = ask({ lens: 'booked' }).value;
    expect(a.accounts[0]).toEqual({ id: 'chk', name: 'Checking', type: 'checking', archived: false, balance: 860 });
    expect(a.envelopes[0]).toEqual({ id: 'groc', name: 'Groceries', category: 'Food', archived: false, balance: 149.5 });
  });

  it('leaves archived entries out unless includeArchived, and unallocated ignores the filter', () => {
    const d = data();
    const without = ask({ lens: 'booked' }, d).value;
    const withAll = ask({ lens: 'booked', includeArchived: true }, d).value;
    expect(without.accounts.map(x => x.id)).toEqual(['chk', 'sav']);
    expect(withAll.accounts.map(x => x.id)).toEqual(['chk', 'old', 'sav']);
    expect(withAll.envelopes.map(x => x.id)).toEqual(['groc', 'rent', 'gone']);
    expect(withAll.accounts[1]).toMatchObject({ id: 'old', archived: true, balance: round2(25.555) });
    expect(withAll.envelopes[2]).toMatchObject({ id: 'gone', archived: true, balance: 0 });
    expect(without.unallocated).toBe(withAll.unallocated);
    expect(without.unallocated).toBe(appComposition(d, { lens: 'booked' }).unallocated);
  });

  it('reads an envelope with no rows as 0', () => {
    expect(balanceOf(ask({ lens: 'booked' }).value.envelopes, 'rent')).toBe(0);
  });

  it('refuses horizon with another lens', () => {
    for (const lens of ['today', 'booked']) {
      const r = ask({ lens, horizon: 'eom' });
      expect(r.ok).toBe(false);
      expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'horizon', message: 'only allowed with lens forecast' }] } });
    }
  });

  it('refuses a horizon that is neither a preset nor a real date', () => {
    const bad = (horizon) => ask({ lens: 'forecast', horizon });
    for (const h of ['soon', '2026-02-30', '2026-13-01', '3M', '']) {
      const r = bad(h);
      expect(r.ok, h).toBe(false);
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors).toEqual([{ path: 'horizon', message: 'must be one of: eom, 3m, 6m, 12m, or a real date (YYYY-MM-DD)' }]);
    }
  });

  it('refuses a missing or unknown lens', () => {
    const missing = ask({});
    expect(missing.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'lens', message: 'is required' }] } });
    expect(ask({ lens: 'nope' }).error.code).toBe('bad_input');
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = data();
    const before = JSON.stringify(d);
    expect(ask({ lens: 'forecast', horizon: '6m', includeArchived: true }, d).ok).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('balances query — totals', () => {
  // The Dashboard hero's figures, as js/pages/dashboard.js buildHero computes them.
  function heroTotals(d, opts) {
    const { acc, env, unallocated } = appComposition(d, opts);
    const isBalanced = Math.abs(unallocated) < 0.01;
    const envTotal = Array.from(env.values()).reduce((s, v) => s + v, 0);
    const acctTotal = identityAccountTotal(acc, d.accounts);
    const assignedPct = acctTotal > 0.01 ? Math.max(0, Math.min(100, Math.round((envTotal / acctTotal) * 100))) : (isBalanced ? 100 : 0);
    return { envelopes: round2(envTotal), accounts: round2(acctTotal), assignedPct };
  }

  for (const [label, input, opts] of [
    ['booked', { lens: 'booked' }, { lens: 'booked' }],
    ['today', { lens: 'today' }, { lens: 'today' }],
    ['forecast eom', { lens: 'forecast', horizon: 'eom' }, { lens: 'forecast', horizon: 'eom' }],
  ]) {
    it(`${label} totals equal the hero's`, () => {
      const d = data();
      expect(ask(input, d).value.totals).toEqual(heroTotals(d, opts));
    });
  }

  it('reads the fixture: archived accounts count toward the identity total, the archive filter changes nothing', () => {
    const without = ask({ lens: 'booked' }).value;
    const withAll = ask({ lens: 'booked', includeArchived: true }).value;
    // chk 860 + sav 189.5 + old 25.555; envelopes groc 149.5.
    expect(without.totals).toEqual({ envelopes: 149.5, accounts: round2(860 + 189.5 + 25.555), assignedPct: 14 });
    expect(withAll.totals).toEqual(without.totals);
  });

  it('caps the percentage at 100 when envelopes hold more than the accounts', () => {
    const d = data({ transactions: [
      { id: 'f9', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 5000, lines: [{ envelope_id: 'groc', amount: 5000 }], status: 'posted' },
    ] });
    expect(ask({ lens: 'booked' }, d).value.totals.assignedPct).toBe(100);
  });
});
