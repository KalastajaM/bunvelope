// js/ai/stream.js — turn a Messages API event stream back into a Message.
//
// Both transports produce the same server-sent-event stream: the direct path
// gets it from Anthropic, the relay path gets it forwarded by our server. So
// the parsing and accumulation live here once, and the transport only has to
// supply bytes.
//
// The accumulator matters more than the parser. Text arrives as deltas, but so
// does a tool call's `input`, one JSON fragment at a time — a partial fragment
// is not parseable, so it has to be buffered whole and parsed at block close.
// Getting that wrong looks like a model that suddenly stops calling tools.
//
// Pure except for the fetch reader passed in. No DOM.

/**
 * Split a byte stream into SSE `data:` payloads.
 *
 * Kept separate from the accumulator so it can be tested with plain strings.
 *
 * @param {string} chunk       newly arrived text
 * @param {string} carry       leftover from the previous chunk
 * @returns {{ events: Array<object>, carry: string }}
 */
export function parseSseChunk(chunk, carry = '') {
  const buffer = carry + chunk;
  // An event ends at a blank line. Anything after the last one is a partial
  // event and has to wait for more bytes.
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = [];

  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        // A malformed event is not worth killing the turn over; the
        // accumulator simply never sees it.
      }
    }
  }

  return { events, carry: rest };
}

/**
 * Rebuild a Message from its stream events.
 *
 * Usage:
 *   const acc = createMessageAccumulator();
 *   for (const event of events) acc.push(event, { onText });
 *   const message = acc.finish();
 */
export function createMessageAccumulator() {
  const message = {
    id: null,
    model: null,
    role: 'assistant',
    content: [],
    stop_reason: null,
    usage: null,
  };
  // Tool inputs stream as JSON fragments; buffer per block index.
  const partialJson = new Map();

  return {
    push(event, { onText } = {}) {
      switch (event?.type) {
        case 'message_start': {
          const m = event.message || {};
          message.id = m.id ?? message.id;
          message.model = m.model ?? message.model;
          message.usage = m.usage ?? message.usage;
          break;
        }

        case 'content_block_start': {
          const block = event.content_block || {};
          message.content[event.index] = block.type === 'tool_use'
            ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
            : { ...block };
          if (block.type === 'tool_use') partialJson.set(event.index, '');
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta || {};
          const block = message.content[event.index];
          if (delta.type === 'text_delta') {
            if (block) block.text = (block.text || '') + delta.text;
            if (onText) onText(delta.text, event.index);
          } else if (delta.type === 'input_json_delta') {
            partialJson.set(event.index, (partialJson.get(event.index) || '') + delta.partial_json);
          } else if (delta.type === 'thinking_delta' && block) {
            block.thinking = (block.thinking || '') + delta.thinking;
          } else if (delta.type === 'signature_delta' && block) {
            // The signature is what lets a thinking block be sent back on the
            // next turn of a tool loop; without it the API rejects the block.
            block.signature = delta.signature;
          }
          break;
        }

        case 'content_block_stop': {
          const raw = partialJson.get(event.index);
          if (raw !== undefined) {
            const block = message.content[event.index];
            // Always JSON.parse — never string-match a tool input. An empty
            // fragment means a tool called with no arguments, which is valid.
            try {
              if (block) block.input = raw ? JSON.parse(raw) : {};
            } catch {
              if (block) block.input = {};
            }
            partialJson.delete(event.index);
          }
          break;
        }

        case 'message_delta': {
          if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
          if (event.usage) message.usage = { ...(message.usage || {}), ...event.usage };
          break;
        }

        case 'error': {
          const err = new Error(event.error?.message || 'stream error');
          err.code = event.error?.type || 'stream_error';
          throw err;
        }

        default:
          break;
      }
    },

    finish() {
      // Holes appear if a block index never opened; drop them so callers can
      // iterate content without guarding every entry.
      message.content = message.content.filter(Boolean);
      return message;
    },
  };
}

/**
 * Consume a fetch Response body as an event stream and return the Message.
 *
 * @param {Response} response
 * @param {(text: string) => void=} onText
 * @returns {Promise<object>}
 */
export async function readMessageStream(response, onText) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response body is not readable');

  const decoder = new TextDecoder();
  const acc = createMessageAccumulator();
  let carry = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, carry: next } = parseSseChunk(decoder.decode(value, { stream: true }), carry);
    carry = next;
    for (const event of events) acc.push(event, { onText });
  }

  // Flush whatever the final chunk left behind.
  const { events } = parseSseChunk('\n\n', carry);
  for (const event of events) acc.push(event, { onText });

  return acc.finish();
}
