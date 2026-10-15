// tests/core-investment-commands.test.js — the investment.* commands: each
// pinned to what the js/state/investments.js writer it replaced stored on the
// same fixture (the writers were removed in 2c; these expected values were
// checked against them side by side before), renameSymbol over transactions and every part of
// meta.investments in one commit, setPayeeRule tagging rows with applyTo, and
// all of them committed meta-primary through a browser session.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/data.js', () => ({
  saveMeta: vi.fn(async () => {}),
}));

import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { getInvestmentsMeta } from '../js/state/investments.js';
import { createBrowserSession } from '../js/session/browser-session.js';
import { createMetaQueue } from '../js/state/meta-queue.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const OCT_2 = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: OCT_2, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const ACCOUNTS = [
  { id: 'acc1', name: 'Broker', type: 'investment' },
  { id: 'acc2', name: 'Fund', type: 'investment' },
];
const INV = {
  prices: { 'AAPL.US': { price: 100, asOf: '2026-09-01' }, 'OLD.HE': { price: 12.5, asOf: '2026-04-01' } },
  holdingOverrides: {
    acc1: { 'AAPL.US': { units: 2, costBasis: 150 }, 'OLD.HE': { units: 5, costBasis: 50, priceUrl: 'https://markets.ft.com/x' } },
    acc2: { 'OLD.HE': { units: 1, costBasis: 10 } },
  },
  payeeRules: { 'broker x': 'OLD.HE', unrelated: 'AAPL.US' },
  manualRows: {
    acc1: {
      'OLD.HE': [{ id: 'm1', date: '2026-04-01', direction: 'buy', units: 1, amount: 10 }],
      'AAPL.US': [
        { id: 'm2', date: '2026-05-01', direction: 'buy', units: 1, amount: 90 },
        { id: 'm3', date: '2026-06-01', direction: 'sell', units: 1, amount: 95, note: 'trim' },
      ],
    },
  },
  priceHistory: { 'AAPL.US': [{ date: '2026-09-01', price: 100 }], 'OLD.HE': [{ date: '2026-04-01', price: 12.5 }] },
};
const META = { schemaVersion: 8, currency: 'EUR', investments: INV };
const itx = (id, symbol, extra = {}) => ({
  id, type: 'investment_transfer', amount: 10, date: '2026-10-01', from_account: 'bank', to_account: 'acc1', payee: 'Broker X', symbol, ...extra,
});
const data = (meta = META, transactions = []) => deepFreeze({
  meta, accounts: ACCOUNTS, envelopes: [], budgetItems: [], envelopeTemplates: [], transactions,
});

function run(name, input, d, opts) {
  const r = runCommand(registry, d, name, input, ctx(), opts);
  if (r.ok) {
    const again = runCommand(registry, d, name, input, ctx(), opts);
    expect(again.value.diff).toEqual(r.value.diff);
    const applied = applyDiff(d, r.value.diff);
    expect(applied.ok).toBe(true);
    for (const [kind, v] of Object.entries(applied.value)) expect(v).toEqual(r.value.changes[kind]);
  }
  return r;
}
const errPaths = (r) => r.error.params.errors.map(e => e.path);

/**
 * The meta the old writer stored: the fixture's meta with `mutate` applied to
 * a copy of its investments, every one of the five parts present (the writers
 * always stored the full shape).
 */
function expectMeta(mutate, meta = META) {
  const inv = { prices: {}, holdingOverrides: {}, payeeRules: {}, manualRows: {}, priceHistory: {}, ...structuredClone(meta.investments ?? {}) };
  mutate(inv);
  return { ...meta, investments: inv };
}

describe('investment.setPrice', () => {
  it('equals setPrice: rounded price, asOf, fx, and a history point', async () => {
    const fx = { currency: 'USD', price: 110.123, rate: 0.91 };
    const r = run('investment.setPrice', { symbol: ' aapl.us ', price: 101.1234567, asOf: '2026-10-01', fx }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.prices['AAPL.US'] = { price: 101.12346, asOf: '2026-10-01', fx };
      inv.priceHistory['AAPL.US'].push({ date: '2026-10-01', price: 101.12346 });
    }));
    expect(r.value.changes.meta.investments.prices['AAPL.US']).toEqual({ price: 101.12346, asOf: '2026-10-01', fx });
    expect(r.value.changes.meta.investments.priceHistory['AAPL.US']).toEqual([
      { date: '2026-09-01', price: 100 }, { date: '2026-10-01', price: 101.12346 },
    ]);
    expect(Object.keys(r.value.changes)).toEqual(['meta']);
  });

  it('asOf defaults to ctx.todayIso; without fx an earlier one is dropped', async () => {
    const m = { investments: { prices: { X: { price: 1, asOf: '2026-09-01', fx: { currency: 'USD', price: 1.1, rate: 0.9 } } } } };
    const r = run('investment.setPrice', { symbol: 'X', price: 2 }, data(m));
    expect(r.value.changes.meta.investments.prices.X).toEqual({ price: 2, asOf: '2026-10-02' });
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.prices.X = { price: 2, asOf: '2026-10-02' };
      inv.priceHistory.X = [{ date: '2026-10-02', price: 2 }];
    }, m));
  });

  it('the same price on the same day changes nothing', () => {
    const r = run('investment.setPrice', { symbol: 'AAPL.US', price: 100, asOf: '2026-09-01' }, data());
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({});
  });

  it('refuses an empty symbol and a negative price, where the writer did nothing', () => {
    expect(errPaths(runCommand(registry, data(), 'investment.setPrice', { symbol: '  ', price: 1 }, ctx()))).toEqual(['symbol']);
    expect(errPaths(runCommand(registry, data(), 'investment.setPrice', { symbol: 'X', price: -1 }, ctx()))).toEqual(['price']);
  });
});

describe('investment.setHolding and removeHolding', () => {
  it('setHolding equals setHoldingOverride: rounded, name and URL only when non-empty', async () => {
    const input = { account: 'acc2', symbol: 'nokia.he', units: 1.23456789, costBasis: 10.006, name: ' Nokia ', priceUrl: '  ' };
    const r = run('investment.setHolding', input, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.holdingOverrides.acc2['NOKIA.HE'] = { units: 1.234568, costBasis: 10.01, name: 'Nokia' };
    }));
    expect(r.value.changes.meta.investments.holdingOverrides.acc2['NOKIA.HE']).toEqual({ units: 1.234568, costBasis: 10.01, name: 'Nokia' });
  });

  it('setHolding replaces an override wholesale, so a blank URL clears the old one', async () => {
    const input = { account: 'acc1', symbol: 'OLD.HE', units: 5, costBasis: 50 };
    const original = data(); const d = { ...original, transactions: [], meta: { ...original.meta, investments: { ...original.meta.investments, manualRows: {} } } };
    const r = run('investment.setHolding', input, d);
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.manualRows = {};
      inv.holdingOverrides.acc1['OLD.HE'] = { units: 5, costBasis: 50 };
    }));
    expect(r.value.changes.meta.investments.holdingOverrides.acc1['OLD.HE']).toEqual({ units: 5, costBasis: 50 });
  });

  it('setHolding with the stored values changes nothing', () => {
    const d = { ...data(), transactions: [], meta: { investments: { holdingOverrides: { acc1: { 'AAPL.US': { units: 2, costBasis: 150 } } } } } };
    const r = run('investment.setHolding', { account: 'acc1', symbol: 'AAPL.US', units: 2, costBasis: 150 }, d);
    expect(r.value.changes).toEqual({});
  });

  it('setHolding refuses an unknown account and an empty symbol', () => {
    expect(errPaths(runCommand(registry, data(), 'investment.setHolding', { account: 'nope', symbol: 'X', units: 1, costBasis: 1 }, ctx()))).toEqual(['account']);
    expect(errPaths(runCommand(registry, data(), 'investment.setHolding', { account: 'acc1', symbol: '', units: 1, costBasis: 1 }, ctx()))).toEqual(['symbol']);
  });

  it('removeHolding equals removeHoldingOverride and prunes an emptied account', async () => {
    const r = run('investment.removeHolding', { account: 'acc2', symbol: 'old.he' }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { delete inv.holdingOverrides.acc2; }));
    expect(r.value.changes.meta.investments.holdingOverrides.acc2).toBeUndefined();
    const r2 = run('investment.removeHolding', { account: 'acc1', symbol: 'AAPL.US' }, data());
    expect(Object.keys(r2.value.changes.meta.investments.holdingOverrides.acc1)).toEqual(['OLD.HE']);
  });

  it('removeHolding of an absent override changes nothing; an empty symbol is refused', () => {
    expect(run('investment.removeHolding', { account: 'acc2', symbol: 'AAPL.US' }, data()).value.changes).toEqual({});
    expect(errPaths(runCommand(registry, data(), 'investment.removeHolding', { account: 'acc2', symbol: ' ' }, ctx()))).toEqual(['symbol']);
  });
});

describe('investment manual rows', () => {
  it('addManualRow equals addManualRow, with an m- id from ctx.newId()', async () => {
    const row = { date: '2026-10-01', direction: 'sell', units: -3, amount: 40, note: 'fee' };
    const r = run('investment.addManualRow', { account: 'acc1', symbol: 'aapl.us', row }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.manualRows.acc1['AAPL.US'].push({ id: 'm-n1', date: '2026-10-01', direction: 'sell', units: 0, amount: 40, note: 'fee' });
    }));
    expect(r.value.value).toEqual({ id: 'm-n1' });
    expect(r.value.changes.meta.investments.manualRows.acc1['AAPL.US'][2]).toEqual({
      id: 'm-n1', date: '2026-10-01', direction: 'sell', units: 0, amount: 40, note: 'fee',
    });
  });

  it('addManualRow keeps signed adjust deltas and creates the account and symbol buckets', async () => {
    const row = { date: '2026-10-01', direction: 'adjust', units: 10, amount: -5 };
    const r = run('investment.addManualRow', { account: 'acc2', symbol: 'SPLIT', row }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.manualRows.acc2 = { SPLIT: [{ id: 'm-n1', ...row }] };
    }));
    expect(r.value.changes.meta.investments.manualRows.acc2.SPLIT).toEqual([
      { id: 'm-n1', date: '2026-10-01', direction: 'adjust', units: 10, amount: -5 },
    ]);
  });

  it('updateManualRow equals updateManualRow: same id and place, normalised fields', async () => {
    const row = { date: '2026-05-02', direction: 'buy', units: 2, amount: 180 };
    const r = run('investment.updateManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'm2', row }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.manualRows.acc1['AAPL.US'][0] = { id: 'm2', ...row }; }));
    expect(r.value.changes.meta.investments.manualRows.acc1['AAPL.US'].map(x => x.id)).toEqual(['m2', 'm3']);
    expect(r.value.changes.meta.investments.manualRows.acc1['AAPL.US'][0]).toEqual({ id: 'm2', ...row });
  });

  it('updateManualRow refuses an unknown id, where the writer silently wrote nothing', () => {
    const r = runCommand(registry, data(), 'investment.updateManualRow',
      { account: 'acc1', symbol: 'AAPL.US', id: 'nope', row: { date: '2026-05-02', units: 1, amount: 1 } }, ctx());
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['id']);
  });

  it('updateManualRow with the stored fields changes nothing', () => {
    const row = { date: '2026-06-01', direction: 'sell', units: 1, amount: 95, note: 'trim' };
    expect(run('investment.updateManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'm3', row }, data()).value.changes).toEqual({});
  });

  it('removeManualRow equals removeManualRow and prunes emptied symbol and account keys', async () => {
    const r = run('investment.removeManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'm2' }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.manualRows.acc1['AAPL.US'].shift(); }));
    const solo = { investments: { manualRows: { acc2: { X: [{ id: 'm9', date: '2026-01-01', direction: 'buy', units: 1, amount: 1 }] } } } };
    const r2 = run('investment.removeManualRow', { account: 'acc2', symbol: 'x', id: 'm9' }, data(solo));
    expect(r2.value.changes.meta).toEqual(expectMeta(inv => { inv.manualRows = {}; }, solo));
    expect(r2.value.changes.meta.investments.manualRows).toEqual({});
  });

  it('removeManualRow of an unknown id changes nothing', () => {
    expect(run('investment.removeManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'nope' }, data()).value.changes).toEqual({});
  });

  it('refuses an empty symbol and an unknown account', () => {
    const row = { date: '2026-10-01', units: 1, amount: 1 };
    expect(errPaths(runCommand(registry, data(), 'investment.addManualRow', { account: 'acc1', symbol: ' ', row }, ctx()))).toEqual(['symbol']);
    expect(errPaths(runCommand(registry, data(), 'investment.addManualRow', { account: 'zz', symbol: 'X', row }, ctx()))).toEqual(['account']);
    expect(errPaths(runCommand(registry, data(), 'investment.removeManualRow', { account: 'acc1', symbol: '', id: 'm1' }, ctx()))).toEqual(['symbol']);
  });
});

describe('cleanup under an account that no longer exists', () => {
  // 'gone' is not in ACCOUNTS: the account was deleted, its investment data stayed.
  const orphan = {
    investments: {
      holdingOverrides: { gone: { X: { units: 1, costBasis: 1 } } },
      manualRows: {
        gone: { X: [
          { id: 'm1', date: '2026-01-01', direction: 'buy', units: 1, amount: 1 },
          { id: 'm2', date: '2026-02-01', direction: 'buy', units: 2, amount: 2 },
        ] },
      },
    },
  };

  it('removeHolding removes the override, as removeHoldingOverride does', async () => {
    const r = run('investment.removeHolding', { account: 'gone', symbol: 'x' }, data(orphan));
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.holdingOverrides = {}; }, orphan));
    expect(r.value.changes.meta.investments.holdingOverrides).toEqual({});
  });

  it('removeManualRow removes the row, as removeManualRow does', async () => {
    const r = run('investment.removeManualRow', { account: 'gone', symbol: 'X', id: 'm1' }, data(orphan));
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.manualRows.gone.X.shift(); }, orphan));
    expect(r.value.changes.meta.investments.manualRows.gone.X.map(x => x.id)).toEqual(['m2']);
  });

  it('updateManualRow updates the row, as updateManualRow does', async () => {
    const row = { date: '2026-02-02', direction: 'sell', units: 1, amount: 3 };
    const r = run('investment.updateManualRow', { account: 'gone', symbol: 'X', id: 'm2', row }, data(orphan));
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.manualRows.gone.X[1] = { id: 'm2', ...row }; }, orphan));
    expect(r.value.changes.meta.investments.manualRows.gone.X[1]).toEqual({ id: 'm2', ...row });
  });

  it('the three refuse a blank account', () => {
    const row = { date: '2026-02-02', units: 1, amount: 1 };
    expect(errPaths(runCommand(registry, data(orphan), 'investment.removeHolding', { account: ' ', symbol: 'X' }, ctx()))).toEqual(['account']);
    expect(errPaths(runCommand(registry, data(orphan), 'investment.removeManualRow', { account: '', symbol: 'X', id: 'm1' }, ctx()))).toEqual(['account']);
    expect(errPaths(runCommand(registry, data(orphan), 'investment.updateManualRow', { account: '', symbol: 'X', id: 'm1', row }, ctx()))).toEqual(['account']);
  });
});

describe('investment.setPayeeRule', () => {
  it('equals setPayeeRule: lowercased key, uppercased symbol', async () => {
    const r = run('investment.setPayeeRule', { payee: '  Avanza Pro ', symbol: ' vwce.de ' }, data());
    expect(r.value.changes.meta).toEqual(expectMeta(inv => { inv.payeeRules['avanza pro'] = 'VWCE.DE'; }));
    expect(r.value.changes.meta.investments.payeeRules['avanza pro']).toBe('VWCE.DE');
    expect(Object.keys(r.value.changes)).toEqual(['meta']);
  });

  it('an existing equal rule changes nothing', () => {
    expect(run('investment.setPayeeRule', { payee: 'Broker X', symbol: 'old.he' }, data()).value.changes).toEqual({});
  });

  it('refuses a placeholder or blank payee and a blank symbol', () => {
    for (const payee of ['', 'Investment', ' investment sale ']) {
      expect(errPaths(runCommand(registry, data(), 'investment.setPayeeRule', { payee, symbol: 'X' }, ctx()))).toEqual(['payee']);
    }
    expect(errPaths(runCommand(registry, data(), 'investment.setPayeeRule', { payee: 'Avanza', symbol: ' ' }, ctx()))).toEqual(['symbol']);
  });

  it('applyTo sets symbol and modified_at on the given rows, in the same commit as the rule', () => {
    const rows = [itx('a', undefined, { payee: 'Avanza' }), itx('b', '', { payee: 'avanza' }), itx('c', undefined, { payee: 'Avanza' })];
    const r = run('investment.setPayeeRule', { payee: 'Avanza', symbol: 'vwce.de', applyTo: ['a', 'b'] }, data(META, rows));
    expect(r.ok).toBe(true);
    const stamp = OCT_2.toISOString();
    // The unmapped page's map, written out.
    expect(r.value.changes.transactions).toEqual(rows.map(x => (['a', 'b'].includes(x.id) ? { ...x, symbol: 'VWCE.DE', modified_at: stamp } : x)));
    expect(r.value.changes.transactions[2]).toBe(rows[2]);
    expect(r.value.changes.meta.investments.payeeRules.avanza).toBe('VWCE.DE');
    expect(r.value.value).toEqual({ payee: 'avanza', symbol: 'VWCE.DE', tagged: 2 });
  });

  it('applyTo tags rows even when the rule is already there, and refuses an unknown id', () => {
    const rows = [itx('a', undefined)];
    const r = run('investment.setPayeeRule', { payee: 'Broker X', symbol: 'OLD.HE', applyTo: ['a'] }, data(META, rows));
    expect(Object.keys(r.value.changes)).toEqual(['transactions']);
    expect(r.value.changes.transactions[0].symbol).toBe('OLD.HE');
    const bad = runCommand(registry, data(META, rows), 'investment.setPayeeRule', { payee: 'Broker X', symbol: 'OLD.HE', applyTo: ['a', 'zz'] }, ctx());
    expect(bad.error.code).toBe('bad_input');
    expect(errPaths(bad)).toEqual(['applyTo[1]']);
  });
});

describe('investment.tagSymbol', () => {
  const stamp = OCT_2.toISOString();
  // Legacy shapes the engine accepts and transaction.amend would rewrite or refuse.
  const dividend = itx('d', undefined, { payee: 'Investment', direction: 'dividend', fee: 1.5, units: 2, pricePerUnit: 3 });
  const unitlessSell = itx('s', undefined, { payee: 'Investment sale', direction: 'sell' });
  const noDirection = itx('n', undefined, { payee: '' });
  const other = itx('o', undefined);

  it('sets only symbol and modified_at: the page\'s {...row, symbol, modified_at}', () => {
    const rows = [dividend, unitlessSell, noDirection, other];
    const r = run('investment.tagSymbol', { ids: ['d', 's', 'n'], symbol: ' vwce.de ' }, data(META, rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual([
      { ...dividend, symbol: 'VWCE.DE', modified_at: stamp },
      { ...unitlessSell, symbol: 'VWCE.DE', modified_at: stamp },
      { ...noDirection, symbol: 'VWCE.DE', modified_at: stamp },
      other,
    ]);
    expect(r.value.changes.transactions[3]).toBe(other);
    expect(Object.keys(r.value.changes)).toEqual(['transactions']);
    expect(r.value.value).toEqual({ symbol: 'VWCE.DE', tagged: 3 });
  });

  it('a legacy dividend keeps fee, units and price; no envelope_id is added', () => {
    const r = run('investment.tagSymbol', { ids: ['d'], symbol: 'X' }, data(META, [dividend]));
    const row = r.value.changes.transactions[0];
    expect(row).toMatchObject({ fee: 1.5, units: 2, pricePerUnit: 3 });
    expect(Object.hasOwn(row, 'envelope_id')).toBe(false);
  });

  it('tags a sell without units, which transaction.amend refuses', () => {
    const amend = runCommand(registry, data(META, [unitlessSell]), 'transaction.amend', { id: 's', symbol: 'X' }, ctx());
    expect(amend.ok).toBe(false);
    const r = run('investment.tagSymbol', { ids: ['s'], symbol: 'X' }, data(META, [unitlessSell]));
    expect(r.value.changes.transactions[0]).toEqual({ ...unitlessSell, symbol: 'X', modified_at: stamp });
  });

  it('a row already carrying the symbol changes nothing', () => {
    expect(run('investment.tagSymbol', { ids: ['a'], symbol: 'x' }, data(META, [itx('a', 'X')])).value.changes).toEqual({});
  });

  it('refuses an unknown id and a blank symbol', () => {
    const bad = runCommand(registry, data(META, [other]), 'investment.tagSymbol', { ids: ['o', 'zz'], symbol: ' ' }, ctx());
    expect(bad.error.code).toBe('bad_input');
    expect(errPaths(bad)).toEqual(['symbol', 'ids[1]']);
  });

  it('setPayeeRule with applyTo tags the same way', () => {
    const rows = [dividend, unitlessSell];
    const tag = run('investment.tagSymbol', { ids: ['d', 's'], symbol: 'X' }, data(META, rows));
    const rule = run('investment.setPayeeRule', { payee: 'Avanza', symbol: 'X', applyTo: ['d', 's'] }, data(META, rows));
    expect(rule.value.changes.transactions).toEqual(tag.value.changes.transactions);
  });

  it('through a session: one batch of rows, the edits in the change log', async () => {
    const ctl = sessionSetup(META, [unitlessSell, other]);
    const r = await ctl.session.dispatch('investment.tagSymbol', { ids: ['s'], symbol: 'X' });
    expect(r.ok).toBe(true);
    expect(ctl.writes).toHaveLength(1);
    expect(ctl.state.transactions[0]).toEqual({ ...unitlessSell, symbol: 'X', modified_at: stamp });
    expect(ctl.state.meta.change_log.map(e => [e.id, e.fields])).toEqual([['s', ['symbol']]]);
  });

  it('is refused under strict-ledger on a past posted row', () => {
    const past = [itx('p', undefined, { date: '2026-09-01' })];
    const r = runCommand(registry, data(META, past), 'investment.tagSymbol', { ids: ['p'], symbol: 'X' }, ctx(), { policies: [strictLedger] });
    expect(r.error.code).toBe('ledger_history_locked');
  });
});

describe('investment.renameSymbol', () => {
  const rows = [
    itx('t1', 'old.he'),
    itx('t2', ' OLD.HE '),
    itx('t3', 'AAPL.US'),
    { id: 't4', type: 'expense', amount: 5, date: '2026-10-01', account: 'bank', payee: 'Shop' },
  ];

  it('equals renameSymbol: rows rewritten without modified_at, every meta part moved', async () => {
    const r = run('investment.renameSymbol', { from: 'OLD.HE', to: 'new.he' }, data(META, rows));
    expect(r.value.changes.transactions).toEqual([{ ...rows[0], symbol: 'NEW.HE' }, { ...rows[1], symbol: 'NEW.HE' }, rows[2], rows[3]]);
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.prices = { 'AAPL.US': INV.prices['AAPL.US'], 'NEW.HE': INV.prices['OLD.HE'] };
      inv.priceHistory = { 'AAPL.US': INV.priceHistory['AAPL.US'], 'NEW.HE': INV.priceHistory['OLD.HE'] };
      inv.holdingOverrides = {
        acc1: { 'AAPL.US': INV.holdingOverrides.acc1['AAPL.US'], 'NEW.HE': INV.holdingOverrides.acc1['OLD.HE'] },
        acc2: { 'NEW.HE': INV.holdingOverrides.acc2['OLD.HE'] },
      };
      inv.manualRows = { acc1: { 'AAPL.US': INV.manualRows.acc1['AAPL.US'], 'NEW.HE': INV.manualRows.acc1['OLD.HE'] } };
      inv.payeeRules = { 'broker x': 'NEW.HE', unrelated: 'AAPL.US' };
    }));
    expect(r.value.changes.transactions.map(t => t.symbol)).toEqual(['NEW.HE', 'NEW.HE', 'AAPL.US', undefined]);
    expect(r.value.changes.transactions[0].modified_at).toBeUndefined();
    expect(r.value.changes.transactions[2]).toBe(rows[2]);
    const inv = r.value.changes.meta.investments;
    expect(inv.prices).toEqual({ 'AAPL.US': INV.prices['AAPL.US'], 'NEW.HE': INV.prices['OLD.HE'] });
    expect(inv.priceHistory['NEW.HE']).toEqual(INV.priceHistory['OLD.HE']);
    expect(inv.holdingOverrides.acc1['NEW.HE']).toEqual(INV.holdingOverrides.acc1['OLD.HE']);
    expect(inv.holdingOverrides.acc2).toEqual({ 'NEW.HE': INV.holdingOverrides.acc2['OLD.HE'] });
    expect(inv.manualRows.acc1['NEW.HE']).toEqual(INV.manualRows.acc1['OLD.HE']);
    expect(inv.manualRows.acc1['OLD.HE']).toBeUndefined();
    expect(inv.payeeRules).toEqual({ 'broker x': 'NEW.HE', unrelated: 'AAPL.US' });
    expect(r.value.value).toEqual({ from: 'OLD.HE', to: 'NEW.HE', transactions: 2 });
  });

  it('a target that already exists keeps its own values; the old ones are dropped', async () => {
    const r = run('investment.renameSymbol', { from: 'OLD.HE', to: 'AAPL.US' }, data(META, rows));
    expect(r.value.changes.meta).toEqual(expectMeta(inv => {
      inv.prices = { 'AAPL.US': INV.prices['AAPL.US'] };
      inv.priceHistory = { 'AAPL.US': INV.priceHistory['AAPL.US'] };
      inv.holdingOverrides = { acc1: { 'AAPL.US': INV.holdingOverrides.acc1['AAPL.US'] }, acc2: { 'AAPL.US': INV.holdingOverrides.acc2['OLD.HE'] } };
      inv.manualRows = { acc1: { 'AAPL.US': INV.manualRows.acc1['AAPL.US'] } };
      inv.payeeRules = { 'broker x': 'AAPL.US', unrelated: 'AAPL.US' };
    }));
    const inv = r.value.changes.meta.investments;
    expect(inv.prices).toEqual({ 'AAPL.US': INV.prices['AAPL.US'] });
    expect(inv.holdingOverrides.acc1).toEqual({ 'AAPL.US': INV.holdingOverrides.acc1['AAPL.US'] });
    expect(inv.manualRows.acc1).toEqual({ 'AAPL.US': INV.manualRows.acc1['AAPL.US'] });
  });

  it('meta only when no row carries the symbol', async () => {
    const r = run('investment.renameSymbol', { from: 'OLD.HE', to: 'NEW.HE' }, data(META, [rows[2]]));
    expect(Object.keys(r.value.changes)).toEqual(['meta']);
  });

  it('an equal rename, or one of a symbol nothing knows, changes nothing', () => {
    expect(run('investment.renameSymbol', { from: 'old.he', to: ' OLD.HE ' }, data(META, rows)).value.changes).toEqual({});
    expect(run('investment.renameSymbol', { from: 'NONE', to: 'OTHER' }, data(META, rows)).value.changes).toEqual({});
  });

  it('refuses a blank from or to', () => {
    expect(errPaths(runCommand(registry, data(), 'investment.renameSymbol', { from: ' ', to: 'X' }, ctx()))).toEqual(['from']);
    expect(errPaths(runCommand(registry, data(), 'investment.renameSymbol', { from: 'X', to: '' }, ctx()))).toEqual(['to']);
  });

  it('is refused under strict-ledger when it rewrites a past posted row', () => {
    const past = [itx('p', 'OLD.HE', { date: '2026-09-01' })];
    const r = runCommand(registry, data(META, past), 'investment.renameSymbol', { from: 'OLD.HE', to: 'NEW.HE' }, ctx(), { policies: [strictLedger] });
    expect(r.error.code).toBe('ledger_history_locked');
  });
});

function sessionSetup(meta, transactions = []) {
  const state = { budgetFolder: { name: 'A' }, meta: structuredClone(meta), accounts: ACCOUNTS, envelopes: [], budgetItems: [], envelopeTemplates: [], transactions };
  const writes = [];
  const saveMeta = vi.fn(async () => {});
  const queue = createMetaQueue((folder, m) => saveMeta(folder, m));
  const runMetaExclusive = vi.fn(queue.runExclusive);
  const updateMeta = vi.fn(queue.update);
  let n = 0;
  const session = createBrowserSession({
    state, registry, updateMeta, runMetaExclusive,
    writeBatch: async (ref, items) => { writes.push(items); },
    currentGeneration: () => 1,
    notify: vi.fn(),
    clock: () => OCT_2,
    newId: () => `id${++n}`,
    isVersionConflict: () => false,
  });
  return { state, session, writes, saveMeta, runMetaExclusive, updateMeta };
}

describe('through a browser session', () => {
  const setup = sessionSetup;

  it.each([
    ['investment.setPrice', { symbol: 'AAPL.US', price: 101, asOf: '2026-10-01' }],
    ['investment.setHolding', { account: 'acc2', symbol: 'X', units: 1, costBasis: 1 }],
    ['investment.removeHolding', { account: 'acc2', symbol: 'OLD.HE' }],
    ['investment.addManualRow', { account: 'acc1', symbol: 'X', row: { date: '2026-10-01', units: 1, amount: 1 } }],
    ['investment.updateManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'm2', row: { date: '2026-10-01', units: 1, amount: 1 } }],
    ['investment.removeManualRow', { account: 'acc1', symbol: 'AAPL.US', id: 'm2' }],
    ['investment.setPayeeRule', { payee: 'Avanza', symbol: 'X' }],
    ['investment.renameSymbol', { from: 'OLD.HE', to: 'NEW.HE' }],
  ])('%s commits meta in one batch, inside the meta queue', async (name, input) => {
    const ctl = setup(META);
    const r = await ctl.session.dispatch(name, input);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ committed: true, published: true });
    expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect(ctl.saveMeta).not.toHaveBeenCalled();
    expect(ctl.writes).toHaveLength(1);
    expect(ctl.writes[0].map(i => i.filename)).toContain('budget-meta.json');
  });

  it('renameSymbol writes rows and meta in one batch, and logs the symbol edits', async () => {
    const ctl = setup(META, [itx('t1', 'old.he'), itx('t2', 'AAPL.US')]);
    const r = await ctl.session.dispatch('investment.renameSymbol', { from: 'OLD.HE', to: 'NEW.HE' });
    expect(r.ok).toBe(true);
    expect(ctl.writes).toHaveLength(1);
    expect(ctl.writes[0].map(i => i.filename).sort()).toEqual(['budget-meta.json', 'transactions.json']);
    expect(ctl.state.transactions.map(t => t.symbol)).toEqual(['NEW.HE', 'AAPL.US']);
    expect(ctl.state.transactions[0].modified_at).toBeUndefined();
    expect(getInvestmentsMeta(ctl.state.meta).prices['NEW.HE']).toEqual(INV.prices['OLD.HE']);
    expect(ctl.state.meta.change_log).toHaveLength(1);
    expect(ctl.state.meta.change_log[0]).toMatchObject({ op: 'edit', id: 't1', fields: ['symbol'], at: OCT_2.toISOString() });
  });

  it('setPayeeRule with applyTo writes the rule and the tagged rows in one batch', async () => {
    const ctl = setup(META, [itx('a', undefined, { payee: 'Avanza' }), itx('b', undefined, { payee: 'Other' })]);
    const r = await ctl.session.dispatch('investment.setPayeeRule', { payee: 'Avanza', symbol: 'vwce.de', applyTo: ['a'] });
    expect(r.ok).toBe(true);
    expect(ctl.writes).toHaveLength(1);
    expect(ctl.state.transactions[0]).toMatchObject({ symbol: 'VWCE.DE', modified_at: OCT_2.toISOString() });
    expect(ctl.state.transactions[1].symbol).toBeUndefined();
    expect(getInvestmentsMeta(ctl.state.meta).payeeRules.avanza).toBe('VWCE.DE');
    expect(ctl.state.meta.change_log.map(e => [e.id, e.fields])).toEqual([['a', ['symbol']]]);
  });

  it('undo of a rename restores the rows and the meta', async () => {
    const ctl = setup(META, [itx('t1', 'old.he')]);
    const r = await ctl.session.dispatch('investment.renameSymbol', { from: 'OLD.HE', to: 'NEW.HE' });
    const undone = await ctl.session.undo(r.value.undo);
    expect(undone.ok).toBe(true);
    expect(ctl.state.transactions[0].symbol).toBe('old.he');
    expect(ctl.state.meta.investments).toEqual(INV);
  });
});


describe('value-only holding metadata', () => {
  it('persists the choice without losing stored cost, and can restore cost tracking', () => {
    const r = run('investment.setHolding', { account: 'acc1', symbol: 'RING', units: 10, costBasis: 100, valuationOnly: true }, data());
    expect(r.ok).toBe(true);
    expect(r.value.changes.meta.investments.holdingOverrides.acc1.RING)
      .toEqual({ units: 10, costBasis: 100, valuationOnly: true });
    const restored = run('investment.setHolding', { account: 'acc1', symbol: 'RING', units: 10, costBasis: 100 }, data(r.value.changes.meta));
    expect(restored.value.changes.meta.investments.holdingOverrides.acc1.RING).toEqual({ units: 10, costBasis: 100 });
  });
});
