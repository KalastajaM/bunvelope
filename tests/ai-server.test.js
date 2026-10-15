// tests/ai-server.test.js — exercises server/ai/client.js with the
// Anthropic SDK fully mocked. Verifies request shape, prompt-cache
// breakpoints, JSON validation, LRU caching, and rate limiting.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// IMPORTANT: vi.mock is hoisted; pull the mock before the SUT imports.
const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {}
    messages = { create: messagesCreate };
    // The refusal fallback goes through the beta endpoint (js/ai/fallback.js).
    beta = { messages: { create: messagesCreate } };
  },
}));

beforeEach(() => {
  // BYOK: keys are passed per-call. Leftover env-var noise from previous
  // suites would have been a config bug pre-BYOK; clear it so we never
  // accidentally rely on it.
  delete process.env.ANTHROPIC_API_KEY;
  messagesCreate.mockReset();
});

const TEST_KEY = 'sk-ant-test';

async function importFresh() {
  // Fresh module instances so the in-memory LRU/rate-windows are clean.
  vi.resetModules();
  const { runInsight, AiError } = await import('../server/ai/client.js');
  return { runInsight, AiError };
}

function jsonReply(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    usage: { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

describe('runInsight request shape', () => {
  it('uses the right model and sets cache breakpoints on system + context', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'Hi', bullets: ['a', 'b', 'c'] }));
    await runInsight({
      feature: 'monthly_briefing',
      context: { foo: 'bar' },
      locale: 'en',
      userId: 'u1',
      apiKey: TEST_KEY,
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    // System has two text blocks; first is cache-controlled.
    expect(Array.isArray(call.system)).toBe(true);
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.system[1].cache_control).toBeUndefined();
    // User message has a budget_context block with cache_control.
    const userMsg = call.messages[0];
    expect(userMsg.role).toBe('user');
    expect(userMsg.content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(userMsg.content[0].text).toContain('<budget_context>');
  });

  it('whatif uses Sonnet 5.5, with thinking off and no temperature (a 400 there)', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ answer: 'Yes', assumptions: [] }));
    await runInsight({ feature: 'whatif', context: {}, locale: 'en', input: 'hi', userId: 'u', apiKey: TEST_KEY });
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5-5');
    expect(call).not.toHaveProperty('temperature');
    expect(call.thinking).toEqual({ type: 'between_tools' });
  });

  it('keeps the temperature for Haiku, which accepts it', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'h', bullets: ['x', 'y', 'z'] }));
    await runInsight({ feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY });
    const call = messagesCreate.mock.calls[0][0];
    expect(call.temperature).toBe(0.2);
    expect(call).not.toHaveProperty('thinking');
  });

  it('runs a saved Sonnet 4.6 choice as Sonnet 5.5', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'h', bullets: ['x', 'y', 'z'] }));
    await runInsight({
      feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u',
      modelOverride: 'claude-sonnet-4-6', apiKey: TEST_KEY,
    });
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5-5');
    expect(call).not.toHaveProperty('temperature');
  });

  it('names the language, Dutch included, in the system context', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'h', bullets: ['x', 'y', 'z'] }));
    await runInsight({ feature: 'monthly_briefing', context: {}, locale: 'nl', userId: 'u', apiKey: TEST_KEY });
    expect(messagesCreate.mock.calls[0][0].system[1].text).toContain('Language: Dutch');
  });

  it('clamps unknown model overrides', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'h', bullets: ['x', 'y', 'z'] }));
    await runInsight({
      feature: 'monthly_briefing',
      context: {}, locale: 'en', userId: 'u',
      modelOverride: 'gpt-4',
      apiKey: TEST_KEY,
    });
    // Falls back to feature default.
    expect(messagesCreate.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('runInsight caching', () => {
  it('returns cached response on identical second call', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce(jsonReply({ headline: 'h', bullets: ['1', '2', '3'] }));
    const a = await runInsight({ feature: 'monthly_briefing', context: { x: 1 }, locale: 'en', userId: 'u', apiKey: TEST_KEY });
    const b = await runInsight({ feature: 'monthly_briefing', context: { x: 1 }, locale: 'en', userId: 'u', apiKey: TEST_KEY });
    expect(a).toEqual(b);
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it('noCache flag bypasses cache', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValue(jsonReply({ headline: 'h', bullets: ['1', '2', '3'] }));
    await runInsight({ feature: 'monthly_briefing', context: { x: 1 }, locale: 'en', userId: 'u', apiKey: TEST_KEY });
    await runInsight({ feature: 'monthly_briefing', context: { x: 1 }, locale: 'en', userId: 'u', noCache: true, apiKey: TEST_KEY });
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('does not cache whatif (cacheable: false)', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValue(jsonReply({ answer: 'a', assumptions: [] }));
    await runInsight({ feature: 'whatif', context: { x: 1 }, locale: 'en', input: 'q', userId: 'u', apiKey: TEST_KEY });
    await runInsight({ feature: 'whatif', context: { x: 1 }, locale: 'en', input: 'q', userId: 'u', apiKey: TEST_KEY });
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });
});

describe('runInsight error mapping', () => {
  it('throws no_user_api_key when called without an apiKey (BYOK)', async () => {
    const { runInsight } = await importFresh();
    await expect(runInsight({ feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u' }))
      .rejects.toMatchObject({ code: 'no_user_api_key', status: 412 });
  });

  it('translates SDK 401 to invalid_user_api_key (BYOK)', async () => {
    const { runInsight } = await importFresh();
    const sdkErr = new Error('401'); sdkErr.status = 401;
    messagesCreate.mockRejectedValueOnce(sdkErr);
    await expect(runInsight({ feature: 'anomaly', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY }))
      .rejects.toMatchObject({ code: 'invalid_user_api_key', status: 401 });
  });

  it('translates SDK 429 to upstream_rate_limited', async () => {
    const { runInsight } = await importFresh();
    const sdkErr = new Error('429'); sdkErr.status = 429;
    messagesCreate.mockRejectedValueOnce(sdkErr);
    await expect(runInsight({ feature: 'anomaly', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY }))
      .rejects.toMatchObject({ code: 'upstream_rate_limited' });
  });

  it('translates SDK 500 to upstream_unavailable', async () => {
    const { runInsight } = await importFresh();
    const sdkErr = new Error('500'); sdkErr.status = 500;
    messagesCreate.mockRejectedValueOnce(sdkErr);
    await expect(runInsight({ feature: 'anomaly', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY }))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('reports a refusal as ai_refused, not as a bad response, and does not cache it', async () => {
    const { runInsight } = await importFresh();
    const refusal = {
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms' },
      usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    messagesCreate.mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    const args = { feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY };
    await expect(runInsight(args)).rejects.toMatchObject({ code: 'ai_refused', status: 422 });
    await expect(runInsight(args)).rejects.toMatchObject({ code: 'ai_refused' });
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('rejects unparseable model JSON', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await expect(runInsight({ feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY }))
      .rejects.toMatchObject({ code: 'ai_bad_response' });
  });

  it('never hands raw model text to the client or the logs, logs its length', async () => {
    const { runInsight } = await importFresh();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const warn = vi.fn();
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'SECRET-MODEL-TEXT not json' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    try {
      const err = await runInsight({
        feature: 'monthly_briefing', context: {}, locale: 'en', userId: 'u', apiKey: TEST_KEY,
        logger: { warn, info: vi.fn() },
      }).catch((e) => e);
      expect(err.code).toBe('ai_bad_response');
      expect(err.extra).toBeNull();
      expect(JSON.stringify(err)).not.toContain('SECRET-MODEL-TEXT');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-MODEL-TEXT');
      expect(warn.mock.calls[0][0].rawLength).toBe('SECRET-MODEL-TEXT not json'.length);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
    }
  });
});

describe('runInsight rate limit', () => {
  it('throws rate_limited after the per-user/per-feature cap', async () => {
    const { runInsight } = await importFresh();
    messagesCreate.mockResolvedValue(jsonReply({ headline: 'h', bullets: ['1', '2', '3'] }));
    // monthly_briefing cap is 6/min/user. Bust the cache by varying context.
    const user = 'busy-user';
    for (let i = 0; i < 6; i++) {
      await runInsight({ feature: 'monthly_briefing', context: { i }, locale: 'en', userId: user, apiKey: TEST_KEY });
    }
    await expect(runInsight({ feature: 'monthly_briefing', context: { i: 999 }, locale: 'en', userId: user, apiKey: TEST_KEY }))
      .rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });
});

describe('prompts: money tokens', () => {
  // COMMON_RULES is prepended to every feature's system prompt, so checking
  // each one pins the instruction wherever a card's prose comes from.
  it('every feature system prompt tells the model to write ⟦amt:…⟧ tokens', async () => {
    const { FEATURES } = await import('../server/ai/prompts.js');
    for (const [name, f] of Object.entries(FEATURES)) {
      expect(f.system, name).toContain('⟦amt:123.45⟧');
      expect(f.system, name).not.toMatch(/write every amount with that symbol/i);
    }
  });

  it('the agent ground rules carry the same instruction', async () => {
    const { AGENT_SYSTEM } = await import('../js/ai/intents.js');
    expect(AGENT_SYSTEM).toContain('⟦amt:123.45⟧');
    expect(AGENT_SYSTEM).not.toContain('currency_symbol');
    expect(AGENT_SYSTEM).toMatch(/never contain tokens/);
  });
});
