import { describe, it, expect } from 'vitest';
import { createRegistry } from '../js/core/registry.js';
import { runCommand, runBatch, runQuery } from '../js/core/pipeline.js';
import { ok, fail } from '../js/core/result.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const ctx = makeCtx({ now: new Date(2026, 9, 1), newId: (() => { let n = 0; return () => `id${++n}`; })() });
const data = () => deepFreeze({ meta: {}, accounts: [{ id: 'bank', name: 'Bank' }], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

function testRegistry() {
  const r = createRegistry();
  r.defineCommand({
    name: 'test.add',
    summary: 'Add a row',
    input: { type: 'object', required: ['account'], properties: { account: { type: 'ref', kind: 'account' }, note: { type: 'string' } } },
    execute(d, input, c) {
      if (input.note === 'refuse') return fail('ledger_set_line', { id: 'x' });
      const row = { id: c.newId(), type: 'expense', amount: 1, date: c.todayIso, account: input.account, note: input.note ?? '' };
      return ok({ changes: { transactions: [...d.transactions, row] }, value: row });
    },
  });
  r.defineCommand({
    name: 'test.addRaw',
    summary: 'Add a row the app generated (no payee aliasing)',
    payeeAliases: false,
    input: { type: 'object', properties: {} },
    execute: (d, _input, c) => ok({ changes: { transactions: [...d.transactions, { id: c.newId(), type: 'expense', amount: 1, date: c.todayIso, account: 'bank' }] }, value: null }),
  });
  r.defineCommand({ name: 'test.bogus', summary: 'x', input: { type: 'object', properties: {} }, execute: () => ok({ changes: { nope: [] }, value: null }) });
  r.defineQuery({ name: 'test.count', summary: 'x', input: { type: 'object', properties: {} }, run: (d) => ok(d.transactions.length) });
  return r;
}

describe('runCommand', () => {
  it('validates, executes and diffs without touching the input data', () => {
    const r = runCommand(testRegistry(), data(), 'test.add', { account: 'bank' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.value.account).toBe('bank');
    expect(r.value.after.transactions).toHaveLength(1);
    expect(r.value.diff.transactions.added).toHaveLength(1);
    expect(r.value.forced).toEqual([]);
  });

  it('returns validation, domain and lookup failures as values', () => {
    const reg = testRegistry();
    expect(runCommand(reg, data(), 'test.add', { account: 'visa' }, ctx).error.code).toBe('bad_input');
    expect(runCommand(reg, data(), 'test.add', { account: 'bank', note: 'refuse' }, ctx).error.code).toBe('ledger_set_line');
    expect(runCommand(reg, data(), 'nope', {}, ctx).error).toEqual({ code: 'unknown_command', params: { name: 'nope' } });
    expect(runCommand(reg, data(), 'test.count', {}, ctx).error.code).toBe('unknown_command');
  });

  it('runs checks, then policies, and collects forced bypasses', () => {
    const checks = (_before, changes) => ok({ ...changes, transactions: changes.transactions.map(t => ({ ...t, checked: true })) });
    const seen = [];
    const policies = [
      { name: 'p1', check: (before, after, cmd) => { seen.push([before.transactions.length, after.transactions[0].checked, cmd.name]); return { forced: ['p1-rule'] }; } },
    ];
    const r = runCommand(testRegistry(), data(), 'test.add', { account: 'bank' }, ctx, { policies, checks });
    expect(seen).toEqual([[0, true, 'test.add']]);
    expect(r.value.forced).toEqual(['p1-rule']);
    const refusing = [{ name: 'p2', check: () => ({ error: { code: 'ledger_future_posted', params: {} } }) }];
    expect(runCommand(testRegistry(), data(), 'test.add', { account: 'bank' }, ctx, { policies: refusing }).error.code).toBe('ledger_future_posted');
  });

  it('tells the checks whether the command opted out of payee aliasing', () => {
    const seen = [];
    const checks = (_before, changes, opts) => { seen.push(opts); return ok(changes); };
    const reg = testRegistry();
    runCommand(reg, data(), 'test.add', { account: 'bank' }, ctx, { checks });
    runCommand(reg, data(), 'test.addRaw', {}, ctx, { checks });
    expect(seen).toEqual([{ applyAliases: true }, { applyAliases: false }]);
  });

  it('throws on a programmer error in a command', () => {
    expect(() => runCommand(testRegistry(), data(), 'test.bogus', {}, ctx)).toThrow(TypeError);
  });
});

describe('runBatch', () => {
  it('runs steps on the accumulating data and returns one diff', () => {
    const r = runBatch(testRegistry(), data(), [
      { name: 'test.add', input: { account: 'bank' } },
      { name: 'test.add', input: { account: 'bank', note: 'two' } },
    ], ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.value).toHaveLength(2);
    expect(r.value.diff.transactions.added).toHaveLength(2);
  });

  it('fails as a whole and names the failing step', () => {
    const r = runBatch(testRegistry(), data(), [
      { name: 'test.add', input: { account: 'bank' } },
      { name: 'test.add', input: { account: 'visa' } },
    ], ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.step).toBe(1);
  });

  it('passes each step its own aliasing choice to the checks', () => {
    const seen = [];
    const checks = (_before, changes, opts) => { seen.push(opts); return ok(changes); };
    runBatch(testRegistry(), data(), [
      { name: 'test.addRaw', input: {} },
      { name: 'test.add', input: { account: 'bank' } },
    ], ctx, { checks });
    expect(seen).toEqual([{ applyAliases: false }, { applyAliases: true }]);
  });

  it('refuses an empty batch', () => {
    expect(runBatch(testRegistry(), data(), [], ctx).error.code).toBe('bad_input');
  });
});

describe('runQuery', () => {
  it('runs queries and refuses commands', () => {
    expect(runQuery(testRegistry(), data(), 'test.count', {}, ctx)).toEqual(ok(0));
    expect(runQuery(testRegistry(), data(), 'test.add', {}, ctx).error.code).toBe('unknown_query');
  });
});
