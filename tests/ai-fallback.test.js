// tests/ai-fallback.test.js — the server-side refusal fallback (BACKLOG
// 2026-09-29): which requests carry it, how a declined model's blocks are
// trimmed, and the relay switching it off when the API rejects it. The
// direct browser path and the agent loop are covered in ai-transport and
// ai-agent-loop.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const messagesCreate = vi.fn();
const betaCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class BadRequestError extends Error { status = 400; }
  class MockAnthropic {
    static BadRequestError = BadRequestError;
    messages = { create: messagesCreate };
    beta = { messages: { create: betaCreate } };
  }
  return { default: MockAnthropic };
});

import { wantsFallback, contentAfterFallback, FALLBACK_BETA, markFallbackRejected, _resetFallbackForTests } from '../js/ai/fallback.js';

beforeEach(() => {
  messagesCreate.mockReset();
  betaCreate.mockReset();
  _resetFallbackForTests();
});

describe('wantsFallback', () => {
  it('is on for the models with refusal fallbacks, off for Haiku and older tiers', () => {
    expect(wantsFallback('claude-opus-5-5')).toBe(true);
    expect(wantsFallback('claude-sonnet-5-5')).toBe(true);
    expect(wantsFallback('claude-haiku-4-5-20251001')).toBe(false);
    expect(wantsFallback('claude-sonnet-4-6')).toBe(false);
    expect(wantsFallback(undefined)).toBe(false);
  });

  it('stays off once the API has rejected it', () => {
    markFallbackRejected();
    expect(wantsFallback('claude-opus-5-5')).toBe(false);
  });
});

describe('contentAfterFallback', () => {
  it('drops the declined model’s thinking and tool calls, keeps its text and everything after the switch', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'Looking at your receipt' },
      { type: 'tool_use', id: 't1', name: 'propose_transactions', input: {} },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: ', it shows 3 items.' },
      { type: 'tool_use', id: 't2', name: 'propose_transactions', input: {} },
    ];
    expect(contentAfterFallback(content).map(b => b.type + (b.id ? `:${b.id}` : ''))).toEqual([
      'text', 'fallback', 'text', 'tool_use:t2',
    ]);
  });

  it('keeps a server tool call that has its result', () => {
    const content = [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    ];
    expect(contentAfterFallback(content)).toHaveLength(3);
  });

  it('returns content without a fallback block as it is', () => {
    const content = [{ type: 'tool_use', id: 't', name: 'x', input: {} }];
    expect(contentAfterFallback(content)).toBe(content);
  });
});

describe('the relay', () => {
  const MSG = [{ role: 'user', content: 'what did I spend on food?' }];
  const reply = { id: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  const importFresh = async () => { vi.resetModules(); return import('../server/ai/client.js'); };

  it('sends the agent intent (Opus) through the beta endpoint with the fallback', async () => {
    const { runMessages } = await importFresh();
    betaCreate.mockResolvedValue(reply);
    await runMessages({ intent: 'agent', messages: MSG, apiKey: 'k', userId: 'u1' });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(betaCreate.mock.calls[0][0]).toMatchObject({ fallbacks: 'default', betas: [FALLBACK_BETA], model: 'claude-opus-5-5' });
  });

  it('sends a Haiku intent as before, without it', async () => {
    const { runMessages } = await importFresh();
    messagesCreate.mockResolvedValue(reply);
    await runMessages({ intent: 'categorize', messages: MSG, apiKey: 'k', userId: 'u2' });
    expect(betaCreate).not.toHaveBeenCalled();
    expect(messagesCreate.mock.calls[0][0]).not.toHaveProperty('fallbacks');
  });

  it('a 400 that goes away without the fallback switches it off', async () => {
    const { runMessages } = await importFresh();
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    betaCreate.mockRejectedValue(new Anthropic.BadRequestError('unknown beta'));
    messagesCreate.mockResolvedValue(reply);
    const out = await runMessages({ intent: 'agent', messages: MSG, apiKey: 'k', userId: 'u3' });
    expect(out).toBe(reply);
    expect(messagesCreate.mock.calls[0][0]).not.toHaveProperty('fallbacks');
    // The next request goes straight to the plain endpoint.
    await runMessages({ intent: 'agent', messages: MSG, apiKey: 'k', userId: 'u3' });
    expect(betaCreate).toHaveBeenCalledTimes(1);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('a 400 both ways is reported, and the fallback stays on', async () => {
    const { runMessages } = await importFresh();
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    betaCreate.mockRejectedValue(new Anthropic.BadRequestError('bad messages'));
    messagesCreate.mockRejectedValue(new Anthropic.BadRequestError('bad messages'));
    await expect(runMessages({ intent: 'agent', messages: MSG, apiKey: 'k', userId: 'u4' })).rejects.toBeTruthy();
    betaCreate.mockResolvedValue(reply);
    await runMessages({ intent: 'agent', messages: MSG, apiKey: 'k', userId: 'u4' });
    expect(betaCreate).toHaveBeenCalledTimes(2);
  });
});
