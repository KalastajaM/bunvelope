// tests/ai-stream.test.js — SSE parsing and message accumulation.
//
// The case worth pinning down is a tool call: its `input` streams as JSON
// fragments that are individually unparseable, so they must be buffered whole
// and parsed at block close. Getting it wrong looks like a model that
// mysteriously stopped calling tools.

import { describe, it, expect } from 'vitest';
import { parseSseChunk, createMessageAccumulator, readMessageStream } from '../js/ai/stream.js';

const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

describe('parseSseChunk', () => {
  it('reads complete events and carries the remainder', () => {
    const first = parseSseChunk('data: {"type":"a"}\n\ndata: {"typ');
    expect(first.events).toEqual([{ type: 'a' }]);
    expect(first.carry).toBe('data: {"typ');

    const second = parseSseChunk('e":"b"}\n\n', first.carry);
    expect(second.events).toEqual([{ type: 'b' }]);
    expect(second.carry).toBe('');
  });

  it('ignores non-data lines and the terminator', () => {
    const { events } = parseSseChunk('event: ping\ndata: [DONE]\n\ndata: {"type":"x"}\n\n');
    expect(events).toEqual([{ type: 'x' }]);
  });

  it('skips a malformed payload rather than throwing', () => {
    const { events } = parseSseChunk('data: {not json\n\ndata: {"type":"ok"}\n\n');
    expect(events).toEqual([{ type: 'ok' }]);
  });

  it('handles an event split across three chunks', () => {
    let carry = '';
    const out = [];
    for (const piece of ['data: {"ty', 'pe":"spl', 'it"}\n\n']) {
      const r = parseSseChunk(piece, carry);
      carry = r.carry;
      out.push(...r.events);
    }
    expect(out).toEqual([{ type: 'split' }]);
  });
});

describe('createMessageAccumulator', () => {
  it('rebuilds a text message and reports deltas as they arrive', () => {
    const acc = createMessageAccumulator();
    const seen = [];
    const push = (e) => acc.push(e, { onText: (t) => seen.push(t) });

    push({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 0 } } });
    push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'You spent ' } });
    push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '€42.50.' } });
    push({ type: 'content_block_stop', index: 0 });
    push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });

    const message = acc.finish();
    expect(message.id).toBe('msg_1');
    expect(message.content).toEqual([{ type: 'text', text: 'You spent €42.50.' }]);
    expect(message.stop_reason).toBe('end_turn');
    expect(message.usage).toEqual({ input_tokens: 10, output_tokens: 9 });
    expect(seen).toEqual(['You spent ', '€42.50.']);
  });

  it('assembles a tool call from unparseable JSON fragments', () => {
    const acc = createMessageAccumulator();
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'query_transactions' } });
    for (const partial_json of ['{"sea', 'rch":"k-mar', 'ket","type":"expense"}']) {
      acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });
    }
    acc.push({ type: 'content_block_stop', index: 0 });
    acc.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });

    const message = acc.finish();
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[0]).toEqual({
      type: 'tool_use', id: 'tu_1', name: 'query_transactions',
      input: { search: 'k-market', type: 'expense' },
    });
  });

  it('treats an empty fragment as a tool called with no arguments', () => {
    const acc = createMessageAccumulator();
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_2', name: 'get_envelopes' } });
    acc.push({ type: 'content_block_stop', index: 0 });
    expect(acc.finish().content[0].input).toEqual({});
  });

  it('keeps text and a tool call from the same turn, in order', () => {
    const acc = createMessageAccumulator();
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here goes:' } });
    acc.push({ type: 'content_block_stop', index: 0 });
    acc.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_3', name: 'get_accounts' } });
    acc.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } });
    acc.push({ type: 'content_block_stop', index: 1 });

    const content = acc.finish().content;
    expect(content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(content[0].text).toBe('Here goes:');
  });

  it('survives malformed tool JSON rather than corrupting the call', () => {
    const acc = createMessageAccumulator();
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_4', name: 'get_envelopes' } });
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"broken' } });
    acc.push({ type: 'content_block_stop', index: 0 });
    expect(acc.finish().content[0].input).toEqual({});
  });

  it('keeps a thinking block\'s signature, which the next turn must send back', () => {
    const acc = createMessageAccumulator();
    acc.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } });
    acc.push({ type: 'content_block_stop', index: 0 });
    expect(acc.finish().content[0]).toEqual({ type: 'thinking', thinking: 'hmm', signature: 'sig-abc' });
  });

  it('throws on an error event', () => {
    const acc = createMessageAccumulator();
    expect(() => acc.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
      .toThrow('Overloaded');
  });
});

function responseFrom(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

describe('readMessageStream', () => {
  it('consumes a whole stream, however the bytes are chopped up', async () => {
    const full = [
      sse({ type: 'message_start', message: { id: 'msg_9', model: 'claude-opus-5' } }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there.' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    ].join('');

    // Chop mid-event on purpose.
    const chunks = [];
    for (let i = 0; i < full.length; i += 17) chunks.push(full.slice(i, i + 17));

    const seen = [];
    const message = await readMessageStream(responseFrom(chunks), (t) => seen.push(t));

    expect(message.id).toBe('msg_9');
    expect(message.content[0].text).toBe('Hello there.');
    expect(message.stop_reason).toBe('end_turn');
    expect(seen.join('')).toBe('Hello there.');
  });

  it('flushes a final event that arrived without its trailing blank line', async () => {
    const message = await readMessageStream(responseFrom([
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tail"}}',
    ]));
    expect(message.content[0].text).toBe('tail');
  });
});
