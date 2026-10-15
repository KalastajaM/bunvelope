// tests/cli-dispatch.test.js
import { describe, it, expect } from 'vitest';
import { parseArgv, isLegacyCommand, helpText, runGenerated, UsageError, parseNow } from '../bin/cli-dispatch.mjs';
import { createRegistry } from '../js/core/registry.js';
import refResolve from '../js/core/queries/ref-resolve.js';
import { ok, fail } from '../js/core/result.js';
import { registry as coreRegistry } from '../js/core/index.js';

function testRegistry() {
  const r = createRegistry();
  r.defineQuery(refResolve);
  r.defineCommand({
    name: 'transaction.recordTest',
    summary: 'Record a test row.',
    input: { type: 'object', required: ['account'], properties: { account: { type: 'ref', kind: 'account', description: 'Account' }, amount: { type: 'money' }, scheduled: { type: 'boolean' } } },
    execute: (d, input) => ok({ changes: {}, value: input }),
  });
  return r;
}

function fakeSession(calls) {
  const data = { accounts: [{ id: 'amex', name: 'Amex' }] };
  return {
    async query(name, input) {
      calls.push(['query', name, input]);
      if (name === 'ref.resolve') return testRegistry().get('ref.resolve').run(data, input);
      return ok(7);
    },
    async dispatch(name, input, opts) { calls.push(['dispatch', name, input, opts]); return ok({ value: input, diff: {}, forced: [], committed: !opts.dryRun, version: 4 }); },
    async dispatchBatch(steps, opts) { calls.push(['batch', steps, opts]); return fail('bad_input', { errors: [], step: 1 }); },
  };
}

describe('parseArgv', () => {
  it('splits positionals and flags, with bare flags as true', () => {
    expect(parseArgv(['transaction', 'record', '--amount', '-12', '--dry-run', '--budget', 'b'])).toEqual({
      positional: ['transaction', 'record'], options: { amount: '-12', 'dry-run': true, budget: 'b' },
    });
  });
  it('refuses duplicate flags', () => {
    expect(() => parseArgv(['--a', '1', '--a', '2'])).toThrow(UsageError);
  });
});

describe('isLegacyCommand', () => {
  it('recognises the protocol-1 commands', () => {
    expect(isLegacyCommand(['budget', 'read', '--id', 'x'])).toBe(true);
    expect(isLegacyCommand(['budgets', 'list'])).toBe(true);
    expect(isLegacyCommand(['ref', 'resolve'])).toBe(false);
  });
  it('finds the command when flags come first, as the protocol-1 parser does', () => {
    expect(isLegacyCommand(['--id', 'x', 'budget', 'read'])).toBe(true);
    expect(isLegacyCommand(['--user', 'a@b', 'budgets', 'list'])).toBe(true);
    expect(isLegacyCommand(['--budget', 'b', 'ref', 'resolve'])).toBe(false);
  });
});

describe('helpText', () => {
  it('lists every entry and details one', () => {
    const all = helpText(testRegistry(), []);
    expect(all).toContain('ref resolve');
    expect(all).toContain('transaction record-test');
    const one = helpText(testRegistry(), ['transaction', 'record-test']);
    expect(one).toContain('--account (required)');
    expect(one).toContain('Record a test row.');
  });
  it('documents batch', () => {
    const text = helpText(testRegistry(), ['batch']);
    expect(text).toContain('"steps"');
    expect(text).not.toContain('Unknown command');
  });
});

describe('helpText over the core registry', () => {
  it('lists every transaction and balance command as kebab-cased verbs', () => {
    const text = helpText(coreRegistry, []);
    for (const verb of ['transaction record', 'transaction amend', 'transaction delete', 'transaction clear',
      'transaction post', 'transaction reverse', 'transaction set-fields', 'transaction merge-transfer',
      'transaction import', 'transaction resolve-duplicates', 'balance adjust', 'balance set', 'account reconcile', 'ref resolve', 'balances', 'forecast balances', 'review month']) {
      expect(text).toContain(verb);
    }
    expect(helpText(coreRegistry, ['transaction', 'record'])).toContain('--from-account');
  });
});

describe('runGenerated', () => {
  const run = (args, extra = {}) => {
    const calls = [];
    const opened = [];
    return runGenerated({
      args,
      registry: testRegistry(),
      openSession: (o) => { opened.push(o); return fakeSession(calls); },
      readJson: async () => extra.json,
    }).then(out => ({ out, calls, opened }));
  };

  it('resolves names to ids and dispatches', async () => {
    const { out, calls, opened } = await run(['transaction', 'record-test', '--budget', 'b', '--account', 'Amex', '--amount', '12.30', '--dry-run', '--policy', 'strict-ledger']);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ protocol_version: 1, value: { account: 'amex', amount: '12.30' }, version: 4 });
    expect(opened[0]).toMatchObject({ budget: 'b', policies: ['strict-ledger'] });
    expect(calls.at(-1)).toEqual(['dispatch', 'transaction.recordTest', { account: 'amex', amount: '12.30' }, { dryRun: true }]);
  });

  it('returns usage errors with exit code 2', async () => {
    expect((await run(['transaction', 'record-test', '--account', 'Amex'])).out.exitCode).toBe(2);
    expect((await run(['no', 'such', '--budget', 'b'])).out.exitCode).toBe(2);
    expect((await run(['transaction', 'record-test', '--budget', 'b', '--file', 'x.json', '--account', 'a'])).out.exitCode).toBe(2);
    expect((await run(['transaction', 'record-test', '--budget', 'b', '--input', 'x.json', '--account', 'a'])).out.exitCode).toBe(2);
  });

  it('refuses a --dry-run that swallowed a value, and a bare --policy', async () => {
    const base = ['transaction', 'record-test', '--budget', 'b', '--account', 'Amex'];
    const a = await run([...base, '--dry-run', 'yes']);
    expect(a.out.exitCode).toBe(2);
    expect(a.calls.some(c => c[0] === 'dispatch')).toBe(false);
    expect((await run([...base, '--policy'])).out.exitCode).toBe(2);
  });

  it('refuses a --policy that names no policy', async () => {
    const base = ['transaction', 'record-test', '--budget', 'b', '--account', 'Amex'];
    for (const value of ['', ',']) {
      const r = await run([...base, '--policy', value]);
      expect(r.out.exitCode).toBe(2);
      expect(r.opened).toHaveLength(0);
    }
  });

  it('returns domain errors with exit code 1 and an English message', async () => {
    const { out } = await run(['transaction', 'record-test', '--budget', 'b', '--account', 'Visa']);
    expect(out.exitCode).toBe(1);
    const err = JSON.parse(out.stderr).error;
    expect(err.code).toBe('ref_not_found');
    expect(err.message).toBe('No account matches "Visa"');
  });

  it('runs a batch from --input and reports the failing step', async () => {
    const json = { steps: [{ name: 'transaction.recordTest', input: { account: 'Amex' } }] };
    const { out, calls } = await run(['batch', '--budget', 'b', '--input', 'ops.json'], { json });
    expect(calls.at(-1)[1]).toEqual([{ name: 'transaction.recordTest', input: { account: 'amex' } }]);
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stderr).error.params.step).toBe(1);
  });

  it('prints help without opening a session', async () => {
    const { out, opened } = await run(['help']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('ref resolve');
    expect(opened).toHaveLength(0);
  });
});

it('resolves schema references recursively in objects and arrays, preserving null and allowed sentinels', async () => {
  const registry = createRegistry();
  registry.defineCommand({ name: 'test.nested', summary: 'Nested refs', input: { type: 'object', properties: {
    lines: { type: 'array', items: { type: 'object', properties: { account: { type: 'ref', kind: 'account', nullable: true, allow: ['none'] } } } },
  } }, execute: () => ok({ changes: {}, value: null }) });
  const calls = [];
  const input = { lines: [{ account: 'Amex' }, { account: null }, { account: 'none' }] };
  const original = structuredClone(input);
  const r = await runGenerated({ args: ['test', 'nested', '--file', 'b.json', '--input', 'ops.json'], registry,
    readJson: async () => input, openSession: () => fakeSession(calls) });
  expect(r.exitCode).toBe(0);
  expect(calls.at(-1)[2]).toEqual({ lines: [{ account: 'amex' }, { account: null }, { account: 'none' }] });
  expect(input).toEqual(original);
});

describe('--now', () => {
  it('parses a date as local midnight and a date-time as that instant', () => {
    const d = parseNow('2026-11-01');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 10, 1, 0, 0]);
    expect(parseNow('2026-11-01T08:30:00Z').toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(parseNow('2026-11-01T08:30')).not.toBeNull();
  });

  it('refuses anything else, including a day that does not exist', () => {
    for (const bad of [true, '', 'tomorrow', '2026-02-30', '2026-13-01', '1/11/2026', '2026-11']) {
      expect(parseNow(bad)).toBeNull();
    }
  });

  it('hands the clock to the session, and is a usage error when malformed', async () => {
    const opened = [];
    const go = (args) => runGenerated({
      args, registry: testRegistry(),
      openSession: (o) => { opened.push(o); return fakeSession([]); },
      readJson: async () => ({}),
    });
    const good = await go(['transaction', 'record-test', '--budget', 'b', '--account', 'Amex', '--amount', '1', '--now', '2026-11-01']);
    expect(good.exitCode).toBe(0);
    expect(opened[0].now.getDate()).toBe(1);
    await go(['transaction', 'record-test', '--budget', 'b', '--account', 'Amex', '--amount', '1']);
    expect(opened[1]).not.toHaveProperty('now');
    const bad = await go(['transaction', 'record-test', '--budget', 'b', '--account', 'Amex', '--amount', '1', '--now', '2026-02-30']);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('--now');
    expect(opened).toHaveLength(2);
  });
});
