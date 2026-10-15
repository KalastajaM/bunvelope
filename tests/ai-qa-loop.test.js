// tests/ai-qa-loop.test.js — QA 2026-09-23 #2 and #4, against a scripted
// transport.
//
// #2: one assistant turn calling two propose tools overwrote `pending`, so the
//     user saw only the second proposal, and on resume BOTH placeholders got
//     that one outcome: the model was told the first was "approved and saved"
//     although the user never saw it.
// #4: categorize sent `toISOString()` dates, a day early east of UTC.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const sendMessages = vi.fn();
vi.mock('../js/ai/transport.js', () => ({
  sendMessagesStream: (...args) => sendMessages(...args),
  sendMessages: (...args) => sendMessages(...args),
  transportKind: () => 'direct',
  isCloudMode: () => false,
}));

let runAgentTurn;
let resumeAgentTurn;
let categorizeRows;

beforeAll(async () => {
  ({ runAgentTurn, resumeAgentTurn } = await import('../js/ai/agent/loop.js'));
  ({ categorizeRows } = await import('../js/ai/categorize.js'));
});

beforeEach(() => sendMessages.mockReset());

function state() {
  return {
    meta: { currency: 'EUR' },
    envelopes: [{ id: 'env-groceries', name: 'Groceries' }, { id: 'env-fun', name: 'Fun' }],
    accounts: [{ id: 'acc-checking', name: 'Checking' }],
    transactions: [],
    budgetItems: [],
    envelopeTemplates: [],
  };
}

const USER = [{ role: 'user', content: 'record lunch and move 20 to fun' }];
const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

const proposeTx = {
  transactions: [{ date: '2026-08-01', payee: 'Lunch', amount: 12, type: 'expense', account_id: 'acc-checking' }],
};
const proposeMove = {
  moves: [{ from_envelope_id: 'env-groceries', to_envelope_id: 'env-fun', amount: 20, date: '2026-08-01' }],
};

describe('two propose calls in one turn (QA #2)', () => {
  it('shows the first proposal and tells the model the second was not shown', async () => {
    sendMessages.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_a', name: 'propose_transactions', input: proposeTx },
        { type: 'tool_use', id: 'tu_b', name: 'propose_envelope_changes', input: proposeMove },
      ],
      stop_reason: 'tool_use',
    });

    const out = await runAgentTurn({ messages: USER, state: state() });
    expect(out.stopped).toBe('awaiting_approval');
    // The one the user sees is the first, not the last.
    expect(out.pending.toolUseId).toBe('tu_a');
    expect(out.pending.toolName).toBe('propose_transactions');

    sendMessages.mockResolvedValueOnce(say('Done.'));
    await resumeAgentTurn({
      messages: out.messages, pending: out.pending, outcome: { approved: true, count: 1 }, state: state(),
    });

    const results = sendMessages.mock.calls[1][0].messages.at(-1).content;
    expect(results.map((r) => r.tool_use_id)).toEqual(['tu_a', 'tu_b']);
    const a = JSON.parse(results[0].content);
    const b = JSON.parse(results[1].content);
    expect(a.status).toBe('approved');
    expect(b.status).not.toBe('approved');
    expect(b.status).toBe('not_shown');
    expect(JSON.stringify(b)).toMatch(/not shown/i);
  });

  it('still answers a read tool in the same turn normally', async () => {
    sendMessages.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tu_r', name: 'query_transactions', input: {} },
        { type: 'tool_use', id: 'tu_a', name: 'propose_transactions', input: proposeTx },
      ],
      stop_reason: 'tool_use',
    });
    const out = await runAgentTurn({ messages: USER, state: state() });
    sendMessages.mockResolvedValueOnce(say('ok'));
    await resumeAgentTurn({
      messages: out.messages, pending: out.pending, outcome: { approved: false }, state: state(),
    });
    const results = sendMessages.mock.calls[1][0].messages.at(-1).content;
    expect(results[0].tool_use_id).toBe('tu_r');
    expect(JSON.parse(results[0].content)).toHaveProperty('total');
    expect(JSON.parse(results[1].content).status).toBe('discarded');
  });
});

describe('categorize dates (QA #4)', () => {
  it('sends the local calendar day of a Date row', async () => {
    sendMessages.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn' });
    // 00:30 local on 5 January: toISOString() says 4 January east of UTC.
    await categorizeRows(
      [{ date: new Date(2026, 0, 5, 0, 30), payee: 'Lidl', amount: -12 }],
      { state: state(), clock: () => new Date(2026, 0, 6, 9, 0) },
    );
    const texts = sendMessages.mock.calls[0][0].messages[0].content.map((c) => c.text).join('\n');
    const rows = JSON.parse(texts.split('Rows to assign:\n')[1].split('\n')[0]);
    expect(rows[0].date).toBe('2026-01-05');
  });
});

describe('categorize reads the injected clock', () => {
  afterEach(() => vi.useRealTimers());

  it('dates the budget by the clock\u2019s local day, whatever the system time says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1999, 11, 31, 23, 0));
    sendMessages.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn' });
    await categorizeRows(
      [{ date: '2031-03-09', payee: 'Lidl', amount: -12 }],
      { state: state(), clock: () => new Date(2031, 2, 10, 0, 30) },
    );
    const texts = sendMessages.mock.calls[0][0].messages[0].content.map((c) => c.text).join('\n');
    const budget = JSON.parse(texts.split('Budget:\n')[1].split('\n')[0]);
    expect(budget.today).toBe('2031-03-10');
  });

  it('reads the clock once for every batch', async () => {
    sendMessages.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    const clock = vi.fn(() => new Date(2031, 2, 10, 12, 0));
    const rows = Array.from({ length: 41 }, (_, i) => ({ date: '2031-03-09', payee: `P${i}`, amount: -1 }));
    await categorizeRows(rows, { state: state(), clock });
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it('throws without a clock instead of reading the wall clock', async () => {
    await expect(categorizeRows([{ date: '2031-03-09', payee: 'Lidl', amount: -12 }], { state: state() }))
      .rejects.toThrow(TypeError);
    expect(sendMessages).not.toHaveBeenCalled();
  });
});
