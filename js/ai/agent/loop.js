// js/ai/agent/loop.js — the agent's tool loop, running in the browser.
//
// It runs here rather than on the server for two independent reasons: static
// mode has no server at all, and in cloud mode the server deliberately cannot
// read the budget (it relays for E2E-encrypted users). The tools therefore
// execute against the in-memory state, which is the only decrypted copy.
//
// The one subtlety is what happens when the model calls a propose tool. Read
// tools resolve and the loop continues; a propose tool *pauses* it. The
// proposal goes to the UI, the user approves or discards, and only then is the
// outcome returned as that tool's `tool_result` so the conversation carries on
// knowing what actually happened. Without the pause the model would be told
// "done" before the user had seen anything; without the resume it would be
// left blind about whether its suggestion landed.

import { sendMessagesStream } from '../transport.js';
import { contentAfterFallback } from '../fallback.js';
import { getToolDefs, runTool, listToolNames } from '../tools/registry.js';
// Tools register as a side effect of being imported. The loop is the only
// thing that needs them registered, so it is the right place to pull them in —
// without this every tool call fails as "Unknown tool" and the loop quietly
// carries on with an error result instead of doing the work.
import '../tools/read.js';
import '../tools/propose.js';

/** Tool round-trips allowed in one user turn before we stop and say so. */
export const MAX_ITERATIONS = 12;

function textFrom(message) {
  return (message?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toolUseBlocks(message) {
  return (message?.content || []).filter((b) => b.type === 'tool_use');
}

/** tool_result for a proposal that was never put in front of the user. */
const NOT_SHOWN = {
  status: 'not_shown',
  note: 'This proposal was not shown to the user and nothing was written. Only one '
    + 'proposal can be reviewed at a time: wait for the outcome of the first, then '
    + 're-propose this one on its own if it is still wanted.',
};

function resultBlock(id, content, isError = false) {
  const block = {
    type: 'tool_result',
    tool_use_id: id,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
  if (isError) block.is_error = true;
  return block;
}

/**
 * Run one user turn to completion, or until a proposal needs approval.
 *
 * @param {object} opts
 * @param {Array} opts.messages          conversation so far; not mutated
 * @param {object} opts.state
 * @param {Array<string>=} opts.toolNames
 * @param {(delta: string) => void=} opts.onTextDelta  fires per token as the
 *   answer is written; the full text is also returned when the turn settles
 * @param {(name: string) => void=} opts.onToolStart
 * @param {AbortSignal=} opts.signal
 * @param {(() => Date)=} opts.clock  where the tools read "now" (the app's
 *   `now`); omitted, the system clock
 * @returns {Promise<{messages: Array, text: string, pending: object|null, stopped: string}>}
 *   `pending` is set when a propose tool paused the loop; pass it back to
 *   `resumeAgentTurn` once the user has decided. `stopped` is the API's
 *   stop_reason, or 'awaiting_approval' / 'iteration_cap'; on 'refusal' the
 *   refused response is not in `messages` and its text is not in `text`.
 */
export async function runAgentTurn({
  messages, state, toolNames, onTextDelta, onToolStart, signal, clock,
}) {
  const tools = getToolDefs(toolNames && toolNames.length ? toolNames : listToolNames());
  let convo = [...messages];
  let lastText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Streamed so the answer fills in as it is written. The resolved value is
    // the same complete Message either way, so the loop below is unchanged.
    const received = await sendMessagesStream({
      intent: 'agent',
      messages: convo,
      tools,
      signal,
      onText: onTextDelta,
    });
    // After a server-side refusal fallback, the declined model's tool calls
    // and thinking are not this turn's: they are neither run nor echoed back
    // (js/ai/fallback.js). Without a fallback block this is the same content.
    const message = { ...received, content: contentAfterFallback(received.content) };

    // A safety classifier (or the model itself) declined. Whatever text
    // arrived before it stopped is a partial answer, not a complete one, and
    // the refused turn stays out of the conversation: the next question then
    // starts from the last turn that did complete. The caller says so to the
    // user; before this the turn just ended with no explanation.
    if (message.stop_reason === 'refusal') {
      return { messages: convo, text: lastText, pending: null, stopped: 'refusal' };
    }

    const text = textFrom(message);
    if (text) lastText = text;

    convo = [...convo, { role: 'assistant', content: message.content }];

    if (message.stop_reason !== 'tool_use') {
      return { messages: convo, text: lastText, pending: null, stopped: message.stop_reason };
    }

    const blocks = toolUseBlocks(message);
    const results = [];
    let pending = null;

    for (const block of blocks) {
      if (onToolStart) onToolStart(block.name);
      try {
        // Tool inputs are parsed JSON from the SDK, never string-matched —
        // models vary their escaping and a raw comparison would be brittle.
        const input = (block.input && typeof block.input === 'object') ? block.input : {};
        const out = runTool(block.name, state, input, clock);

        if (out.kind === 'propose' && pending) {
          // The UI shows one proposal at a time. A second one in the same
          // turn used to overwrite the first, and on resume both slots got
          // the one outcome, so the model heard "approved and saved" for a
          // proposal the user never saw. Answer it now, truthfully.
          results.push(resultBlock(block.id, NOT_SHOWN));
        } else if (out.kind === 'propose') {
          // Hold this one open. Its tool_result is written on resume, once the
          // user has decided, so the model is never told a write happened
          // before it did.
          pending = { toolUseId: block.id, toolName: block.name, proposal: out.proposal };
          results.push(null); // placeholder, filled in by resumeAgentTurn
        } else {
          results.push(resultBlock(block.id, out.result));
        }
      } catch (err) {
        // Hand the failure back as a tool_result rather than aborting the turn:
        // the model can pick a different tool or explain the problem, which is
        // a far better outcome than a dead conversation.
        results.push(resultBlock(block.id, { error: err.message || String(err) }, true));
      }
    }

    if (pending) {
      return {
        messages: convo,
        text: lastText,
        pending: { ...pending, partialResults: results, blocks },
        stopped: 'awaiting_approval',
      };
    }

    // Every tool_result for one assistant turn goes back in a single user
    // message. Splitting them across messages teaches the model to stop
    // making parallel tool calls.
    convo = [...convo, { role: 'user', content: results }];
  }

  return {
    messages: convo,
    text: lastText,
    pending: null,
    stopped: 'iteration_cap',
  };
}

/**
 * Continue a turn that paused on a proposal.
 *
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {object} opts.pending   the object runAgentTurn returned
 * @param {object} opts.outcome   { approved: boolean, count?: number, note?: string }
 * @param {object} opts.state
 * @param {Array<string>=} opts.toolNames
 * @param {(delta: string) => void=} opts.onTextDelta
 * @param {(name: string) => void=} opts.onToolStart
 * @param {AbortSignal=} opts.signal
 * @param {(() => Date)=} opts.clock
 */
export async function resumeAgentTurn({
  messages, pending, outcome, state, toolNames, onTextDelta, onToolStart, signal, clock,
}) {
  // Only the proposal the user actually saw gets the outcome. Any other empty
  // slot (there should be none) is answered as not shown rather than
  // inheriting a decision nobody made about it.
  const filled = pending.partialResults.map((slot, i) => {
    if (slot) return slot;
    const block = pending.blocks[i];
    return block.id === pending.toolUseId
      ? resultBlock(block.id, outcomePayload(outcome))
      : resultBlock(block.id, NOT_SHOWN);
  });

  const convo = [...messages, { role: 'user', content: filled }];
  return runAgentTurn({ messages: convo, state, toolNames, onTextDelta, onToolStart, signal, clock });
}

function outcomePayload(outcome) {
  if (outcome?.approved) {
    return {
      status: 'approved',
      written: outcome.count ?? 0,
      note: outcome.note
        || 'The user approved the proposal and it has been saved to the budget.',
    };
  }
  return {
    status: 'discarded',
    note: outcome?.note
      || 'The user discarded the proposal. Nothing was written. Do not retry the same '
        + 'proposal unless they ask — offer to adjust it or ask what they would prefer.',
  };
}
