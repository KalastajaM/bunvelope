// tests/ai-tools.test.js — the agent's tool surface.
//
// The load-bearing test here is `does not mutate state`: it runs every
// registered tool against a deeply frozen budget and fails if anything writes.
// The whole safety argument for this feature — that a bad model response, or a
// prompt injected through a receipt image, can at worst produce a wrong
// suggestion in a list the user is reviewing — rests on there being no tool
// that writes. This test is what keeps that true as tools get added.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  allTools, getToolDefs, listToolNames, runTool, registerTool, getTool,
} from '../js/ai/tools/registry.js';
import { INTENTS } from '../js/ai/intents.js';
import { queryState } from '../js/ai/query.js';

// Registration happens as a side effect of importing the tool modules, and
// js/ai/agent/loop.js is what pulls them in for the app. Importing the loop
// here rather than the tool modules directly keeps that wiring under test.
beforeAll(async () => {
  await import('../js/ai/agent/loop.js');
});

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

function fixtureState() {
  return {
    meta: { currency: 'EUR', country: 'FI' },
    envelopes: [
      { id: 'env-groceries', name: 'Groceries', category: 'Living', target: 400 },
      { id: 'env-dining', name: 'Dining', category: 'Living' },
      { id: 'env-old', name: 'Retired', archived: true },
    ],
    accounts: [
      { id: 'acc-checking', name: 'Checking', type: 'checking', initialBalance: 1000 },
      { id: 'acc-savings', name: 'Savings', type: 'savings', initialBalance: 5000 },
    ],
    budgetItems: [],
    envelopeTemplates: [],
    transactions: [
      { id: 't1', type: 'expense', date: '2026-08-01', payee: 'K-Market', amount: 42.5, account: 'acc-checking', envelope_id: 'env-groceries', status: 'posted' },
      { id: 't2', type: 'expense', date: '2026-08-05', payee: 'Ravintola', amount: 88, account: 'acc-checking', envelope_id: 'env-dining', status: 'posted' },
      { id: 't3', type: 'income', date: '2026-08-01', payee: 'Salary', amount: 3200, account: 'acc-checking', envelope_id: 'env-groceries', status: 'posted' },
      { id: 't4', type: 'expense', date: '2026-07-11', payee: 'K-Market', amount: 19.9, account: 'acc-checking', envelope_id: 'env-groceries', status: 'posted' },
    ],
  };
}

// Inputs chosen so every tool does real work rather than bailing early.
const SAMPLE_INPUTS = {
  get_envelopes: [{}, { include_archived: true }],
  get_accounts: [{}, { include_archived: true }],
  query_transactions: [
    {},
    { search: 'k-market' },
    { envelope_id: 'env-groceries', date_from: '2026-07-01', date_to: '2026-08-31' },
    { account_id: 'acc-checking', min_amount: 20, max_amount: 100 },
    { type: 'income' },
  ],
  get_envelope_history: [{ envelope_id: 'env-groceries' }, { envelope_id: 'env-dining', months: 3 }],
  get_reports: [{ by: 'envelope' }, { by: 'payee' }, { by: 'income_vs_spending' }],
  get_forecast: [{ envelope_id: 'env-groceries' }, { envelope_id: 'env-dining', months: 1 }],
  get_runway: [{}, { lens: 'forecast', horizon: '6m' }],
  get_net_worth_history: [{}, { months: 6, exclude_accounts: ['acc-savings'] }],
  get_net_worth_projection: [{ years: 5 }, { years: 10, contribution: 'history', exclude_accounts: ['acc-savings'] }],
  propose_transactions: [{
    transactions: [{
      date: '2026-08-20', payee: 'Test', amount: 12, type: 'expense',
      account_id: 'acc-checking', envelope_id: 'env-groceries',
    }],
    summary: 'one row',
  }],
  propose_envelope_changes: [{
    moves: [{ from_envelope_id: 'env-groceries', to_envelope_id: 'env-dining', amount: 50 }],
  }],
};

describe('tool registry', () => {
  it('registers only read and propose tools — there is no write kind', () => {
    for (const tool of allTools()) {
      expect(['read', 'propose']).toContain(tool.kind);
    }
    expect(allTools().length).toBeGreaterThan(0);
  });

  it('rejects a tool with an unknown kind', () => {
    expect(() => registerTool({
      name: 'write_everything', kind: 'write', run: () => {}, description: '', input_schema: {},
    })).toThrow(/unknown kind/);
    expect(getTool('write_everything')).toBe(null);
  });

  it('exposes only wire fields in the tool definitions', () => {
    for (const def of getToolDefs()) {
      expect(Object.keys(def).sort()).toEqual(['description', 'input_schema', 'name']);
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.input_schema.type).toBe('object');
    }
  });

  it('every registered tool is reachable by the agent intent', () => {
    // A tool the server allowlist does not name can never be called, which is
    // a silent dead end rather than an error at runtime.
    const allowed = new Set(INTENTS.agent.allowedTools);
    for (const name of listToolNames()) {
      expect(allowed.has(name), `${name} missing from INTENTS.agent.allowedTools`).toBe(true);
    }
  });

  it('throws a typed error for an unknown tool name', () => {
    expect(() => runTool('nope', fixtureState(), {})).toThrow(/Unknown tool/);
  });

  it('has a sample input for every registered tool', () => {
    // Guards the invariant test below from silently skipping a new tool.
    for (const name of listToolNames()) {
      expect(SAMPLE_INPUTS[name], `no SAMPLE_INPUTS entry for ${name}`).toBeTruthy();
    }
  });
});

describe('the no-write invariant', () => {
  it('no tool mutates state, however it is called', () => {
    for (const name of listToolNames()) {
      for (const input of SAMPLE_INPUTS[name]) {
        const state = deepFreeze(fixtureState());
        // A frozen object throws on assignment in strict mode (ES modules are
        // always strict), so a mutating tool fails loudly here.
        expect(() => runTool(name, state, input), `${name} mutated state`).not.toThrow();
      }
    }
  });

  it('leaves the transaction list in its original order', () => {
    const state = fixtureState();
    const originalOrder = state.transactions.map((t) => t.id);
    for (const name of listToolNames()) {
      for (const input of SAMPLE_INPUTS[name]) runTool(name, state, input);
    }
    expect(state.transactions.map((t) => t.id)).toEqual(originalOrder);
  });
});

describe('propose tools', () => {
  it('return a proposal and report that nothing has been written', () => {
    const state = fixtureState();
    const out = runTool('propose_transactions', state, SAMPLE_INPUTS.propose_transactions[0]);
    expect(out.kind).toBe('propose');
    expect(out.proposal.rows).toHaveLength(1);
    expect(out.result.status).toBe('awaiting_user_approval');
    expect(out.result.note).toMatch(/[Nn]othing has been written/);
  });

  it('do not add anything to the budget', () => {
    const state = fixtureState();
    const before = state.transactions.length;
    runTool('propose_transactions', state, SAMPLE_INPUTS.propose_transactions[0]);
    runTool('propose_envelope_changes', state, SAMPLE_INPUTS.propose_envelope_changes[0]);
    expect(state.transactions).toHaveLength(before);
  });

  it('drop an envelope id the model invented', () => {
    const state = fixtureState();
    const out = runTool('propose_transactions', state, {
      transactions: [{
        date: '2026-08-20', payee: 'Test', amount: 12, type: 'expense',
        envelope_id: 'env-does-not-exist',
      }],
    });
    expect(out.proposal.rows[0].envelope_id).toBe(null);
    expect(out.proposal.warnings.map((w) => w.code)).toContain('unknown_ids');
  });
});

// A fixed local clock, built from components so the day is the same in every zone.
const CLOCK = () => new Date(2026, 8, 15, 10, 0, 0);

describe('runTool clock', () => {
  it('hands the clock to the tool as its third argument', () => {
    const tool = getTool('get_accounts');
    const run = vi.spyOn(tool, 'run');
    try {
      const state = fixtureState();
      runTool('get_accounts', state, {}, CLOCK);
      expect(run).toHaveBeenCalledWith(state, {}, CLOCK);
    } finally {
      run.mockRestore();
    }
  });

  it('reads the wall clock only when the caller gives none', () => {
    const tool = getTool('get_accounts');
    const run = vi.spyOn(tool, 'run');
    try {
      runTool('get_accounts', fixtureState(), {});
      const clock = run.mock.calls[0][2];
      expect(clock()).toBeInstanceOf(Date);
    } finally {
      run.mockRestore();
    }
  });
});

describe('the balance tools read the balances query', () => {
  it('get_accounts asks the clock it was given (the query builds its context from it)', () => {
    const clock = vi.fn(CLOCK);
    runTool('get_accounts', fixtureState(), {}, clock);
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it('get_envelopes asks the clock it was given', () => {
    const clock = vi.fn(CLOCK);
    runTool('get_envelopes', fixtureState(), {}, clock);
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it('get_envelopes returns the Booked rows, with the target from the envelope record', () => {
    // 3200 salary - 42.50 - 19.90 on groceries; 88 on dining.
    expect(runTool('get_envelopes', fixtureState(), {}, CLOCK).result).toEqual([
      { id: 'env-groceries', name: 'Groceries', category: 'Living', balance: 3137.6, target: 400, archived: false },
      { id: 'env-dining', name: 'Dining', category: 'Living', balance: -88, target: null, archived: false },
    ]);
    expect(runTool('get_envelopes', fixtureState(), { include_archived: true }, CLOCK).result[2])
      .toEqual({ id: 'env-old', name: 'Retired', category: null, balance: 0, target: null, archived: true });
  });

  it('get_accounts returns the Booked rows', () => {
    expect(runTool('get_accounts', fixtureState(), {}, CLOCK).result).toEqual([
      { id: 'acc-checking', name: 'Checking', type: 'checking', balance: 4049.6, archived: false },
      { id: 'acc-savings', name: 'Savings', type: 'savings', balance: 5000, archived: false },
    ]);
  });

  it('get_accounts lists archived accounts when asked', () => {
    const state = fixtureState();
    state.accounts.push({ id: 'acc-old', name: 'Closed', type: 'checking', initialBalance: 12.34, archived: true });
    expect(runTool('get_accounts', state, {}, CLOCK).result.map((a) => a.id)).toEqual(['acc-checking', 'acc-savings']);
    expect(runTool('get_accounts', state, { include_archived: true }, CLOCK).result.at(-1))
      .toEqual({ id: 'acc-old', name: 'Closed', type: 'checking', balance: 12.34, archived: true });
  });

  it('get_accounts keeps a missing type as null', () => {
    const state = fixtureState();
    state.accounts[1] = { id: 'acc-savings', name: 'Savings', initialBalance: 5000 };
    expect(runTool('get_accounts', state, {}, CLOCK).result[1].type).toBe(null);
  });
});

describe('the runway, net worth history and projection tools read their core queries', () => {
  const answerOf = (name, input) => {
    const r = queryState(fixtureState(), name, input, CLOCK);
    expect(r.ok).toBe(true);
    return r.value;
  };

  it('get_runway returns the stress.runway answer', () => {
    const { result } = runTool('get_runway', fixtureState(), {}, CLOCK);
    expect(result).toEqual(answerOf('stress.runway', {}));
    // Checking 4049.60 + Savings 5000 is the cash; the fixture has no plan items to burn it.
    expect(result.scenarios.map((s) => s.scenario)).toEqual(['Baseline', 'A', 'B', 'C', 'D', 'E']);
    expect(result.scenarios[0].runway).toBe('unlimited');
  });

  it('get_runway passes the lens and horizon on, and refuses a horizon without the forecast lens', () => {
    const { result } = runTool('get_runway', fixtureState(), { lens: 'forecast', horizon: '6m' }, CLOCK);
    expect(result).toEqual(answerOf('stress.runway', { lens: 'forecast', horizon: '6m' }));
    expect(result.lens).toBe('forecast');
    expect(() => runTool('get_runway', fixtureState(), { horizon: '6m' }, CLOCK)).toThrow(/bad_input/);
  });

  it('get_net_worth_history returns the netWorth.history answer, 24 month-ends then today', () => {
    const { result } = runTool('get_net_worth_history', fixtureState(), {}, CLOCK);
    expect(result).toEqual(answerOf('netWorth.history', {}));
    expect(result.points).toHaveLength(25);
    expect(result.points.at(-1)).toMatchObject({ date: '2026-09-15', total: 9049.6 });
  });

  it('get_net_worth_history takes months and the accounts to leave out', () => {
    const { result } = runTool('get_net_worth_history', fixtureState(), { months: 6, exclude_accounts: ['acc-savings'] }, CLOCK);
    expect(result).toEqual(answerOf('netWorth.history', { months: 6, excludeAccounts: ['acc-savings'] }));
    expect(result.points).toHaveLength(7);
    expect(result.points.at(-1).total).toBe(4049.6);
  });

  it('get_net_worth_projection returns the netWorth.projection answer for the years asked', () => {
    const { result } = runTool('get_net_worth_projection', fixtureState(), { years: 5 }, CLOCK);
    expect(result).toEqual(answerOf('netWorth.projection', { years: 5 }));
    expect(result.years).toBe(5);
    expect(result.accounts.map((a) => a.id)).toEqual(['acc-checking', 'acc-savings']);
  });

  it('get_net_worth_projection passes the contribution source and exclusions on', () => {
    const input = { years: 10, contribution: 'history', exclude_accounts: ['acc-savings'] };
    const { result } = runTool('get_net_worth_projection', fixtureState(), input, CLOCK);
    expect(result).toEqual(answerOf('netWorth.projection', { years: 10, contribution: 'history', excludeAccounts: ['acc-savings'] }));
  });

  it('get_net_worth_projection needs years', () => {
    expect(() => runTool('get_net_worth_projection', fixtureState(), {}, CLOCK)).toThrow(/bad_input/);
  });

  it('asks the clock it was given once, and offers the model no override of the stored plan or accounts', () => {
    for (const [name, input] of [['get_runway', {}], ['get_net_worth_history', {}], ['get_net_worth_projection', { years: 3 }]]) {
      const clock = vi.fn(CLOCK);
      runTool(name, fixtureState(), input, clock);
      expect(clock, name).toHaveBeenCalledTimes(1);
      const props = Object.keys(getTool(name).input_schema.properties);
      expect(props.filter((p) => /override/i.test(p)), name).toEqual([]);
    }
  });
});

describe('read tools', () => {
  it('query_transactions reports totals for the whole match, not just the page', () => {
    const state = fixtureState();
    const { result } = runTool('query_transactions', state, { search: 'k-market' });
    expect(result.matched).toBe(2);
    expect(result.total).toBe(62.4);
    expect(result.truncated).toBe(false);
    expect(result.transactions[0].date).toBe('2026-08-01'); // newest first
  });

  it('query_transactions honours a date range', () => {
    const state = fixtureState();
    const { result } = runTool('query_transactions', state, { date_from: '2026-08-01' });
    expect(result.matched).toBe(3);
  });

  it('get_envelopes hides archived envelopes unless asked', () => {
    const state = fixtureState();
    expect(runTool('get_envelopes', state, {}).result).toHaveLength(2);
    expect(runTool('get_envelopes', state, { include_archived: true }).result).toHaveLength(3);
  });

  it('get_accounts reports a balance derived from the ledger', () => {
    const state = fixtureState();
    const checking = runTool('get_accounts', state, {}).result
      .find((a) => a.id === 'acc-checking');
    // 1000 opening + 3200 salary − 42.50 − 88 − 19.90
    expect(checking.balance).toBe(4049.6);
  });

  it('get_envelope_history splits money in from money out', () => {
    const state = fixtureState();
    // Read at a fixed clock, so August 2026 is always among the months.
    const { result } = runTool('get_envelope_history', state, { envelope_id: 'env-groceries', months: 24 }, () => new Date(2026, 7, 20, 10));
    expect(result.months).toHaveLength(24);
    expect(result.months.at(-1).month).toBe('2026-08');
    expect(result.months.find((m) => m.month === '2026-08')).toEqual({ month: '2026-08', in: 3200, out: 42.5 });
    expect(result.months.find((m) => m.month === '2026-07')).toEqual({ month: '2026-07', in: 0, out: 19.9 });
    expect(result.envelope).toBe('Groceries');
  });
});
