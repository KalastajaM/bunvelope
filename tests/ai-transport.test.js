// tests/ai-transport.test.js — transport selection and the two request shapes.
//
// The direct path's header set is not incidental: without
// `anthropic-dangerous-direct-browser-access` the browser blocks the call at
// CORS before it reaches Anthropic. That header is asserted here so a future
// tidy-up cannot quietly drop it and break static mode.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendMessages, transportKind, isCloudMode, setConsentGate } from '../js/ai/transport.js';
import { setLocalKey, clearLocalKey } from '../js/ai/keystore.js';
import { FALLBACK_BETA, _resetFallbackForTests } from '../js/ai/fallback.js';

// The transport fails closed without a consent gate (js/ai/consent.js
// installs the real one). These tests are about request shapes, so consent
// is granted; tests/ai-qa-consent.test.js covers the gate itself.
beforeEach(() => setConsentGate(async () => true));

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  };
}

function errResponse(status, body) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: async () => JSON.stringify(body),
  };
}

const MSG = [{ role: 'user', content: 'hi' }];

describe('transport selection', () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage();
    globalThis.window = {};
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('picks the relay in cloud mode even when a local key exists', () => {
    globalThis.window.__BUNVELOPE_MODE = { kind: 'cloud' };
    setLocalKey('sk-ant-local');
    expect(isCloudMode()).toBe(true);
    expect(transportKind()).toBe('relay');
  });

  it('picks direct when there is no server but a key is stored', () => {
    setLocalKey('sk-ant-local');
    expect(transportKind()).toBe('direct');
  });

  it('reports no transport when neither is configured', () => {
    clearLocalKey();
    expect(transportKind()).toBe(null);
  });

  it('throws a typed error when nothing is configured', async () => {
    clearLocalKey();
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'no_transport' });
  });
});

describe('direct transport', () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage();
    globalThis.window = {};
    setLocalKey('sk-ant-local');
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('asks for the refusal fallback on an Opus request, and drops it for good after a 400 it caused', async () => {
    _resetFallbackForTests();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unknown beta' } }))
      .mockResolvedValue(okResponse({ id: 'msg_1', content: [] }));
    globalThis.fetch = fetchMock;

    await sendMessages({ intent: 'agent', messages: MSG, model: 'claude-opus-5-5' });
    const [, first] = fetchMock.mock.calls[0];
    expect(first.headers['anthropic-beta']).toBe(FALLBACK_BETA);
    expect(JSON.parse(first.body).fallbacks).toBe('default');
    const [, retry] = fetchMock.mock.calls[1];
    expect(retry.headers).not.toHaveProperty('anthropic-beta');
    expect(JSON.parse(retry.body)).not.toHaveProperty('fallbacks');

    await sendMessages({ intent: 'agent', messages: MSG, model: 'claude-opus-5-5' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('fallbacks');
    _resetFallbackForTests();
  });

  it('sends the headers the browser CORS path requires', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'msg_1', content: [] }));
    globalThis.fetch = fetchMock;

    await sendMessages({
      intent: 'agent',
      messages: MSG,
      tools: [{ name: 'get_accounts' }],
      model: 'claude-opus-5',
      maxTokens: 500,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-local');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(500);
    // The direct path resolves the intent to its system prompt from the same
    // table the server uses, so static and cloud mode cannot drift.
    expect(body.system[0].text).toContain('Bunvelope');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools).toHaveLength(1);
  });

  it('refuses a tool the intent does not declare, before spending the key', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(sendMessages({
      intent: 'categorize',
      messages: MSG,
      tools: [{ name: 'query_transactions' }],
    })).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalises an Anthropic error body', async () => {
    globalThis.fetch = async () => errResponse(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'API key is invalid.' },
    });

    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({
        code: 'authentication_error',
        status: 401,
        message: 'API key is invalid.',
      });
  });

  it('refuses to call out when the key was cleared mid-session', async () => {
    clearLocalKey();
    globalThis.window.__BUNVELOPE_MODE = { kind: 'cloud' };
    // cloud mode → relay, so drop back to static to exercise the guard
    delete globalThis.window.__BUNVELOPE_MODE;
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'no_transport' });
  });
});

describe('relay transport', () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage();
    globalThis.window = { __BUNVELOPE_MODE: { kind: 'cloud' } };
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('posts the intent and never an API key', async () => {
    setLocalKey('sk-ant-should-not-be-sent');
    const fetchMock = vi.fn(async () => okResponse({ id: 'msg_2', content: [] }));
    globalThis.fetch = fetchMock;

    await sendMessages({
      intent: 'categorize',
      messages: MSG,
      tools: [{ name: 'assign_rows' }],
      maxTokens: 1000,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/messages');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.stringify(init.headers)).not.toContain('sk-ant');

    const body = JSON.parse(init.body);
    expect(body.intent).toBe('categorize');
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toBeUndefined(); // the server owns the prompt
  });

  it('normalises a relay error body', async () => {
    globalThis.fetch = async () => errResponse(412, { error: 'no_user_api_key' });
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'no_user_api_key', status: 412 });
  });
});
