// tests/ai-agent-loop.test.js — the tool loop, against a scripted transport.
//
// The behaviour worth pinning down is the pause: a propose tool must stop the
// loop before its tool_result is written, and the result the model eventually
// sees must reflect what the user actually decided — not what was suggested.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const sendMessages = vi.fn();
vi.mock('../js/ai/transport.js', () => ({
  // The loop streams; the mock answers with the settled Message, which is what
  // sendMessagesStream resolves to either way.
  sendMessagesStream: (...args) => sendMessages(...args),
  sendMessages: (...args) => sendMessages(...args),
  transportKind: () => 'direct',
  isCloudMode: () => false,
}));

let runAgentTurn;
let resumeAgentTurn;
let MAX_ITERATIONS;

beforeAll(async () => {
  // Deliberately does NOT import the tool modules: the loop must pull them in
  // itself. It did not, once, and every tool call failed as "Unknown tool"
  // while the conversation carried on as if nothing were wrong.
  ({ runAgentTurn, resumeAgentTurn, MAX_ITERATIONS } = await import('../js/ai/agent/loop.js'));
});

beforeEach(() => sendMessages.mockReset());

function state() {
  return {
    meta: { currency: 'EUR' },
    envelopes: [{ id: 'env-groceries', name: 'Groceries' }],
    accounts: [{ id: 'acc-checking', name: 'Checking', initialBalance: 100 }],
    transactions: [
      { id: 't1', type: 'expense', date: '2026-08-01', payee: 'K-Market', amount: 42.5, account: 'acc-checking', envelope_id: 'env-groceries', status: 'posted' },
    ],
    budgetItems: [],
    envelopeTemplates: [],
  };
}

const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

const callTool = (name, input, id = 'tu_1', text = '') => ({
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'tool_use', id, name, input },
  ],
  stop_reason: 'tool_use',
});

const USER = [{ role: 'user', content: 'what did I spend on groceries?' }];

describe('runAgentTurn', () => {
  it('returns the answer when the model needs no tools', async () => {
    sendMessages.mockResolvedValueOnce(say('You spent €42.50.'));
    const out = await runAgentTurn({ messages: USER, state: state() });
    expect(out.text).toBe('You spent €42.50.');
    expect(out.pending).toBe(null);
    expect(out.stopped).toBe('end_turn');
  });

  it('runs a read tool and feeds the result back', async () => {
    sendMessages
      .mockResolvedValueOnce(callTool('query_transactions', { search: 'k-market' }))
      .mockResolvedValueOnce(say('€42.50 at K-Market.'));

    const out = await runAgentTurn({ messages: USER, state: state() });
    expect(out.text).toBe('€42.50 at K-Market.');

    // Second request carries the tool_result the loop computed locally.
    const second = sendMessages.mock.calls[1][0];
    const resultMsg = second.messages.at(-1);
    expect(resultMsg.role).toBe('user');
    expect(resultMsg.content[0].type).toBe('tool_result');
    expect(JSON.parse(resultMsg.content[0].content).total).toBe(42.5);
  });

  it('hands the tools the clock it was given', async () => {
    sendMessages
      .mockResolvedValueOnce(callTool('get_accounts', {}))
      .mockResolvedValueOnce(say('done'));
    const clock = vi.fn(() => new Date(2026, 8, 15, 10, 0, 0));
    await runAgentTurn({ messages: USER, state: state(), clock });
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it('after a refusal fallback, neither runs nor echoes the declined model\u2019s tool call', async () => {
    sendMessages
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'declined', name: 'get_envelopes', input: {} },
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
          { type: 'tool_use', id: 'served', name: 'get_accounts', input: {} },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce(say('done'));

    await runAgentTurn({ messages: USER, state: state() });
    const second = sendMessages.mock.calls[1][0].messages;
    const echoed = second.at(-2);
    expect(echoed.role).toBe('assistant');
    expect(echoed.content.map((b) => b.id ?? b.type)).toEqual(['fallback', 'served']);
    expect(second.at(-1).content.map((c) => c.tool_use_id)).toEqual(['served']);
  });

  it('sends every tool_result for one turn in a single user message', async () => {
    sendMessages
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'a', name: 'get_envelopes', input: {} },
          { type: 'tool_use', id: 'b', name: 'get_accounts', input: {} },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce(say('done'));

    await runAgentTurn({ messages: USER, state: state() });
    const resultMsg = sendMessages.mock.calls[1][0].messages.at(-1);
    expect(resultMsg.content).toHaveLength(2);
    expect(resultMsg.content.map((c) => c.tool_use_id)).toEqual(['a', 'b']);
  });

  it('reports a failing tool back to the model instead of killing the turn', async () => {
    sendMessages
      .mockResolvedValueOnce(callTool('get_envelope_history', { envelope_id: null }, 'tu_e'))
      .mockResolvedValueOnce(say('I could not look that up.'));

    // No envelope_id → the tool still runs but the loop must survive whatever
    // it does; force a throw to exercise the error path.
    const broken = state();
    Object.defineProperty(broken, 'transactions', {
      get() { throw new Error('boom'); },
    });

    const out = await runAgentTurn({ messages: USER, state: broken });
    const resultMsg = sendMessages.mock.calls[1][0].messages.at(-1);
    expect(resultMsg.content[0].is_error).toBe(true);
    expect(out.text).toBe('I could not look that up.');
  });

  it('reports a refusal and keeps the refused turn out of the conversation', async () => {
    sendMessages
      .mockResolvedValueOnce(callTool('query_transactions', {}, 'tu_1', 'Let me look.'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Your grocer' }],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: null },
      });
    const out = await runAgentTurn({ messages: USER, state: state() });
    expect(out.stopped).toBe('refusal');
    expect(out.pending).toBeNull();
    // The partial answer is neither returned as the answer nor stored: the
    // conversation ends at the tool results, the last turn that completed.
    expect(out.text).toBe('Let me look.');
    expect(JSON.stringify(out.messages)).not.toContain('Your grocer');
    expect(out.messages.at(-1).role).toBe('user');
    expect(out.messages.at(-1).content[0].type).toBe('tool_result');
  });

  it('does not run a tool call that arrived with a refusal', async () => {
    sendMessages.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'query_transactions', input: {} }],
      stop_reason: 'refusal',
    });
    const onToolStart = vi.fn();
    const out = await runAgentTurn({ messages: USER, state: state(), onToolStart });
    expect(out.stopped).toBe('refusal');
    expect(onToolStart).not.toHaveBeenCalled();
    expect(out.messages).toEqual(USER);
    expect(sendMessages).toHaveBeenCalledTimes(1);
  });

  it('stops at the iteration cap rather than looping forever', async () => {
    sendMessages.mockResolvedValue(callTool('get_envelopes', {}));
    const out = await runAgentTurn({ messages: USER, state: state() });
    expect(out.stopped).toBe('iteration_cap');
    expect(sendMessages).toHaveBeenCalledTimes(MAX_ITERATIONS);
  });

  it('passes text deltas through as the answer is written', async () => {
    // The loop hands its onTextDelta to the transport as `onText`; the UI
    // relies on that to fill a bubble instead of waiting for the whole turn.
    sendMessages.mockImplementationOnce(async ({ onText }) => {
      onText?.('You spent ');
      onText?.('€42.50.');
      return say('You spent €42.50.');
    });
    const deltas = [];
    const out = await runAgentTurn({
      messages: USER, state: state(), onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['You spent ', '€42.50.']);
    expect(out.text).toBe('You spent €42.50.');
  });

  it('reports each tool as it starts, for the status line', async () => {
    sendMessages
      .mockResolvedValueOnce(callTool('get_envelopes', {}))
      .mockResolvedValueOnce(say('ok'));
    const started = [];
    await runAgentTurn({ messages: USER, state: state(), onToolStart: (n) => started.push(n) });
    expect(started).toEqual(['get_envelopes']);
  });
});

describe('the propose pause', () => {
  const proposeCall = callTool('propose_transactions', {
    transactions: [{
      date: '2026-08-20', payee: 'Coffee', amount: 4.5, type: 'expense',
      account_id: 'acc-checking', envelope_id: 'env-groceries',
    }],
  }, 'tu_p', 'Here is what I would add:');

  it('pauses before writing any tool_result', async () => {
    sendMessages.mockResolvedValueOnce(proposeCall);
    const out = await runAgentTurn({ messages: USER, state: state() });

    expect(out.stopped).toBe('awaiting_approval');
    expect(out.pending.toolName).toBe('propose_transactions');
    expect(out.pending.proposal.rows).toHaveLength(1);
    // Crucially: the model has NOT been told anything happened yet.
    expect(sendMessages).toHaveBeenCalledTimes(1);
  });

  it('tells the model what was actually written when the user approves', async () => {
    sendMessages.mockResolvedValueOnce(proposeCall);
    const paused = await runAgentTurn({ messages: USER, state: state() });

    sendMessages.mockResolvedValueOnce(say('Added.'));
    const out = await resumeAgentTurn({
      messages: paused.messages,
      pending: paused.pending,
      outcome: { approved: true, count: 1 },
      state: state(),
    });

    const resumed = sendMessages.mock.calls[1][0].messages.at(-1);
    const payload = JSON.parse(resumed.content[0].content);
    expect(resumed.content[0].tool_use_id).toBe('tu_p');
    expect(payload.status).toBe('approved');
    expect(payload.written).toBe(1);
    expect(out.text).toBe('Added.');
  });

  it('tells the model nothing was written when the user discards', async () => {
    sendMessages.mockResolvedValueOnce(proposeCall);
    const paused = await runAgentTurn({ messages: USER, state: state() });

    sendMessages.mockResolvedValueOnce(say('No problem.'));
    await resumeAgentTurn({
      messages: paused.messages,
      pending: paused.pending,
      outcome: { approved: false },
      state: state(),
    });

    const payload = JSON.parse(sendMessages.mock.calls[1][0].messages.at(-1).content[0].content);
    expect(payload.status).toBe('discarded');
    expect(payload.note).toMatch(/Nothing was written/);
  });

  it('keeps read results alongside a paused proposal in the same turn', async () => {
    sendMessages.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'r1', name: 'get_envelopes', input: {} },
        { type: 'tool_use', id: 'p1', name: 'propose_transactions', input: {
          transactions: [{ date: '2026-08-20', payee: 'X', amount: 1, type: 'expense' }],
        } },
      ],
      stop_reason: 'tool_use',
    });
    const paused = await runAgentTurn({ messages: USER, state: state() });
    expect(paused.pending.partialResults[0].tool_use_id).toBe('r1');
    expect(paused.pending.partialResults[1]).toBe(null);

    sendMessages.mockResolvedValueOnce(say('ok'));
    await resumeAgentTurn({
      messages: paused.messages, pending: paused.pending,
      outcome: { approved: true, count: 1 }, state: state(),
    });

    const resumed = sendMessages.mock.calls[1][0].messages.at(-1);
    expect(resumed.content).toHaveLength(2);
    expect(resumed.content.every((c) => c.type === 'tool_result')).toBe(true);
  });
});
