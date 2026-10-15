// tests/core-payee-commands.test.js — payee.merge, .alias, .unalias, .hide and
// .unhide: each equal to what the Payee tidy-up sheet does today, in one
// commit (a merge covers transactions and meta), and a merge refused under
// strict-ledger when it touches a past posted row.
import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { mergePayees, mergePayeeRules } from '../js/state/payee-merge.js';
import { addPayeeAliases, getPayeeAliases, removePayeeAlias, setPayeeHidden, getHiddenPayees } from '../js/state/payee-aliases.js';
import { getPayeeRules } from '../js/state/investments.js';
import { createBrowserSession } from '../js/session/browser-session.js';
import { createMetaQueue } from '../js/state/meta-queue.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const OCT_2 = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: OCT_2, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const tx = (id, payee, extra = {}) => ({ id, type: 'expense', amount: 10, date: '2026-10-01', account: 'bank', payee, ...extra });
const data = (meta = {}, transactions = []) => deepFreeze({
  meta, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions,
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

describe('payee.merge', () => {
  const rows = [
    tx('a', 'LIDL 1234'), tx('b', 'lidl'), tx('c', 'Lidl'), tx('d', 'Kesko'),
    { id: 'f', type: 'fill', date: '2026-10-01', payee: 'lidl', lines: [] },
    { id: 'g', type: 'adjustment', target: 'envelope', amount: 1, date: '2026-10-01', payee: 'lidl 1234' },
  ];
  const meta = {
    schemaVersion: 8,
    investments: { payeeRules: { 'lidl 1234': 'LDL', other: 'X' }, prices: { X: { price: 1, asOf: '2026-10-01' } } },
    payeeAliases: { 'old lidl': 'LIDL 1234' },
    payeeHidden: ['lidl', 'zzz'],
  };
  const input = { from: ['lidl 1234', 'lidl'], fromNames: ['LIDL 1234', 'lidl'], to: 'Lidl' };

  it('equals the sheet\'s sequence: rows, rules, aliases, unhide, in one change set', () => {
    const d = data(meta, rows);
    const r = run('payee.merge', input, d);
    expect(r.ok).toBe(true);

    // The sheet's steps, written out with the pure helpers it calls.
    const stamp = OCT_2.toISOString();
    const expectedRows = mergePayees(rows, new Set(input.from), 'Lidl', stamp).transactions;
    const inv = {
      prices: meta.investments.prices, holdingOverrides: {}, manualRows: {}, priceHistory: {},
      payeeRules: mergePayeeRules(getPayeeRules(meta), new Set(input.from), 'Lidl'),
    };
    const expectedMeta = {
      ...meta, investments: inv,
      payeeAliases: addPayeeAliases(getPayeeAliases(meta), input.fromNames, 'Lidl'),
      payeeHidden: setPayeeHidden(meta.payeeHidden, 'Lidl', false),
    };
    expect(r.value.changes.transactions).toEqual(expectedRows);
    expect(r.value.changes.meta).toEqual(expectedMeta);

    expect(r.value.changes.transactions.map(t => [t.id, t.payee])).toEqual([
      ['a', 'Lidl'], ['b', 'Lidl'], ['c', 'Lidl'], ['d', 'Kesko'], ['f', 'lidl'], ['g', 'lidl 1234'],
    ]);
    expect(r.value.changes.transactions[0].modified_at).toBe(stamp);
    expect(r.value.changes.transactions[2]).toBe(rows[2]);
    expect(r.value.changes.meta.investments.payeeRules).toEqual({ lidl: 'LDL', other: 'X' });
    expect(r.value.changes.meta.payeeAliases).toEqual({ 'lidl 1234': 'Lidl', lidl: 'Lidl', 'old lidl': 'Lidl' });
    expect(r.value.changes.meta.payeeHidden).toEqual(['zzz']);
    expect(r.value.value).toEqual({ changed: 2, to: 'Lidl' });
  });

  it('leaves rules and hidden alone when there is nothing to rename or unhide', () => {
    const m = { schemaVersion: 8, investments: { payeeRules: { other: 'X' } } };
    const r = run('payee.merge', input, data(m, rows));
    expect(r.value.changes.meta.investments).toBe(m.investments);
    expect(Object.hasOwn(r.value.changes.meta, 'payeeHidden')).toBe(false);
    expect(r.value.changes.meta.payeeAliases).toEqual({ 'lidl 1234': 'Lidl', lidl: 'Lidl' });
  });

  it('a merge that rewrites no row changes nothing at all', () => {
    const r = run('payee.merge', { from: ['nobody'], fromNames: ['Nobody'], to: 'Lidl' }, data(meta, rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({});
    expect(r.value.value).toEqual({ changed: 0, to: 'Lidl' });
  });

  it('trims the target and folds the from keys', () => {
    const r = run('payee.merge', { from: ['  LIDL 1234 '], fromNames: ['LIDL 1234'], to: '  Lidl ' }, data({}, rows));
    expect(r.value.changes.transactions[0].payee).toBe('Lidl');
    expect(r.value.value).toEqual({ changed: 1, to: 'Lidl' });
  });

  it('refuses a missing or blank target, and an empty from list', () => {
    const d = data(meta, rows);
    expect(errPaths(runCommand(registry, d, 'payee.merge', { ...input, to: '  ' }, ctx()))).toEqual(['to']);
    expect(errPaths(runCommand(registry, d, 'payee.merge', { ...input, from: [] }, ctx()))).toEqual(['from']);
    expect(errPaths(runCommand(registry, d, 'payee.merge', { ...input, from: ['', ' '] }, ctx()))).toEqual(['from']);
    const noTo = runCommand(registry, d, 'payee.merge', { from: ['a'], fromNames: ['a'] }, ctx());
    expect(noTo.error.code).toBe('bad_input');
  });

  it('is refused under strict-ledger when it touches a past posted row, and is forced through only by force', () => {
    const past = [tx('a', 'LIDL 1234', { date: '2026-09-01' })];
    const r = runCommand(registry, data(meta, past), 'payee.merge', input, ctx(), { policies: [strictLedger] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ledger_history_locked');
    expect(r.error.params).toEqual({ id: 'a', date: '2026-09-01' });
    // A row the policy leaves alone (a scheduled one) merges fine.
    const scheduled = [tx('a', 'LIDL 1234', { status: 'scheduled', date: '2026-11-01' })];
    expect(runCommand(registry, data(meta, scheduled), 'payee.merge', input, ctx(), { policies: [strictLedger] }).ok).toBe(true);
  });
});

describe('payee.alias, unalias, hide and unhide', () => {
  it('alias adds one spelling, as addPayeeAliases does', () => {
    const m = { payeeAliases: { 'lidl 1': 'Lidl', old: 'LIDL' } };
    const r = run('payee.alias', { from: 'LIDL', to: 'Lidl Finland' }, data(m));
    expect(r.value.changes.meta.payeeAliases).toEqual(addPayeeAliases(m.payeeAliases, ['LIDL'], 'Lidl Finland'));
    expect(r.value.changes.meta.payeeAliases).toEqual({ 'lidl 1': 'Lidl Finland', old: 'Lidl Finland', lidl: 'Lidl Finland' });
  });

  it('alias of a name to itself, or an alias already there, changes nothing', () => {
    expect(run('payee.alias', { from: 'Lidl', to: 'Lidl' }, data({ payeeAliases: {} })).value.changes).toEqual({});
    expect(run('payee.alias', { from: 'lidl', to: 'Lidl' }, data({ payeeAliases: { lidl: 'Lidl' } })).value.changes).toEqual({});
  });

  it('alias refuses a blank from or to', () => {
    expect(errPaths(runCommand(registry, data(), 'payee.alias', { from: ' ', to: 'Lidl' }, ctx()))).toEqual(['from']);
    expect(errPaths(runCommand(registry, data(), 'payee.alias', { from: 'x', to: '' }, ctx()))).toEqual(['to']);
  });

  it('unalias forgets one spelling by key, as removePayeeAlias does', () => {
    const m = { payeeAliases: { lidl: 'Lidl', k: 'Kesko' } };
    const r = run('payee.unalias', { key: ' LIDL ' }, data(m));
    expect(r.value.changes.meta.payeeAliases).toEqual(removePayeeAlias(m.payeeAliases, 'lidl'));
    expect(r.value.changes.meta.payeeAliases).toEqual({ k: 'Kesko' });
    expect(run('payee.unalias', { key: 'nope' }, data(m)).value.changes).toEqual({});
    expect(errPaths(runCommand(registry, data(m), 'payee.unalias', { key: '' }, ctx()))).toEqual(['key']);
  });

  it('hide stores the lowercased, sorted, unique list; unhide removes it', () => {
    const m = { payeeHidden: ['zzz'] };
    const hid = run('payee.hide', { payee: ' Lidl ' }, data(m));
    expect(hid.value.changes.meta.payeeHidden).toEqual(setPayeeHidden(m.payeeHidden, 'Lidl', true));
    expect(hid.value.changes.meta.payeeHidden).toEqual(['lidl', 'zzz']);
    const shown = run('payee.unhide', { payee: 'LIDL' }, data({ payeeHidden: ['lidl', 'zzz'] }));
    expect(shown.value.changes.meta.payeeHidden).toEqual(['zzz']);
    expect(getHiddenPayees(shown.value.changes.meta).has('lidl')).toBe(false);
  });

  it('hide of a hidden payee and unhide of a visible one change nothing', () => {
    expect(run('payee.hide', { payee: 'Lidl' }, data({ payeeHidden: ['lidl'] })).value.changes).toEqual({});
    expect(run('payee.unhide', { payee: 'Lidl' }, data({})).value.changes).toEqual({});
    expect(run('payee.unhide', { payee: 'Lidl' }, data({ payeeHidden: ['zzz'] })).value.changes).toEqual({});
  });

  it('hide and unhide refuse a blank payee', () => {
    for (const name of ['payee.hide', 'payee.unhide']) {
      expect(errPaths(runCommand(registry, data(), name, { payee: '  ' }, ctx()))).toEqual(['payee']);
    }
  });
});

describe('through a browser session', () => {
  function setup(meta, transactions = []) {
    const state = { budgetFolder: { name: 'A' }, meta, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions };
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

  it('a merge writes transactions and meta in one batch inside the meta queue, with no change-log entry', async () => {
    const ctl = setup({ schemaVersion: 8, payeeHidden: ['lidl'] }, [tx('a', 'LIDL 1234'), tx('b', 'Kesko')]);
    const r = await ctl.session.dispatch('payee.merge', { from: ['lidl 1234'], fromNames: ['LIDL 1234'], to: 'Lidl' });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ committed: true, published: true });
    expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect(ctl.saveMeta).not.toHaveBeenCalled();
    expect(ctl.writes).toHaveLength(1);
    const names = ctl.writes[0].map(i => i.filename);
    expect(names).toContain('budget-meta.json');
    expect(names.length).toBeGreaterThan(1);
    expect(ctl.state.transactions.map(t => t.payee)).toEqual(['Lidl', 'Kesko']);
    expect(ctl.state.meta.payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
    expect(ctl.state.meta.payeeHidden).toEqual([]);
    // payee is not a money field: the change log stays empty.
    expect(ctl.state.meta.change_log).toBeUndefined();
  });

  it.each([
    ['payee.alias', { from: 'LIDL', to: 'Lidl' }, {}],
    ['payee.unalias', { key: 'lidl' }, { payeeAliases: { lidl: 'Lidl' } }],
    ['payee.hide', { payee: 'Lidl' }, {}],
    ['payee.unhide', { payee: 'Lidl' }, { payeeHidden: ['lidl'] }],
  ])('%s commits meta in one batch, inside the meta queue', async (name, input, meta) => {
    const ctl = setup({ schemaVersion: 8, ...meta });
    const r = await ctl.session.dispatch(name, input);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ committed: true, published: true });
    expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect(ctl.writes).toHaveLength(1);
  });

  it('undo of a merge restores the rows and the meta', async () => {
    const rows = [tx('a', 'LIDL 1234')];
    const ctl = setup({ schemaVersion: 8 }, rows);
    const r = await ctl.session.dispatch('payee.merge', { from: ['lidl 1234'], fromNames: ['LIDL 1234'], to: 'Lidl' });
    const undone = await ctl.session.undo(r.value.undo);
    expect(undone.ok).toBe(true);
    expect(ctl.state.transactions[0].payee).toBe('LIDL 1234');
    expect(ctl.state.meta.payeeAliases).toBeUndefined();
  });
});
