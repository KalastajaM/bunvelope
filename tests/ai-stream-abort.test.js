// runMessagesStream must stop the upstream Claude stream when the browser
// goes away. Otherwise a closed tab keeps generating (and billing) tokens on
// the user's own key until the model finishes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
    // The refusal fallback goes through the beta endpoint (js/ai/fallback.js).
    beta = { messages: { create: messagesCreate } };
  },
}));

beforeEach(() => messagesCreate.mockReset());

function fakeRes() {
  const res = new EventEmitter();
  res.writes = [];
  res.writableFinished = false;
  res.writableEnded = false;
  res.writeHead = vi.fn();
  res.write = vi.fn((chunk) => { res.writes.push(chunk); return true; });
  res.end = vi.fn(() => { res.writableEnded = true; res.writableFinished = true; res.emit('finish'); });
  return res;
}

// An upstream stream that yields one event, then waits until aborted.
function hangingStream(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { id: 'm' } };
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  };
}

const ARGS = {
  intent: 'agent',
  messages: [{ role: 'user', content: 'hi' }],
  apiKey: 'sk-ant-test',
  userId: 'u-stream',
};

describe('runMessagesStream', () => {
  it('aborts the upstream request when the client disconnects', async () => {
    vi.resetModules();
    const { runMessagesStream } = await import('../server/ai/client.js');
    let signal;
    messagesCreate.mockImplementation(async (_body, opts) => {
      signal = opts?.signal;
      return hangingStream(signal);
    });
    const res = fakeRes();
    const done = runMessagesStream({ ...ARGS, res });
    await vi.waitFor(() => expect(res.writes.length).toBe(1));

    res.emit('close'); // browser tab closed mid-stream
    await done;

    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(true);
    // Nothing is written to a socket that is already gone.
    expect(res.writes.length).toBe(1);
  });

  it('does not abort a stream that finished normally', async () => {
    vi.resetModules();
    const { runMessagesStream } = await import('../server/ai/client.js');
    let signal;
    messagesCreate.mockImplementation(async (_body, opts) => {
      signal = opts?.signal;
      return (async function* () { yield { type: 'message_stop' }; })();
    });
    const res = fakeRes();
    await runMessagesStream({ ...ARGS, userId: 'u-stream-2', res });
    res.emit('close');
    expect(signal.aborted).toBe(false);
    expect(res.end).toHaveBeenCalledOnce();
  });
});
