// The cloud client learns once, after sign-in, whether the user has an
// Anthropic key on the server (GET /api/ai/key). Without one isAiAvailable()
// is false, so no entry point is offered and nothing fires a request that
// answers 412 on page load; a 412 from any call records the same.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const appState = { meta: { ai: { enabled: true } }, budgetFolder: 'A' };
vi.mock('../js/app.js', () => ({ state: appState }));

const { loadServerKeyStatus, setServerHasKey, serverKeyMissing, noteAiError } = await import('../js/ai/key-status.js');
const { isAiAvailable, isAiFeatureEnabled, aiInsights } = await import('../js/ai/client.js');
const { aiErrorText, knownAiErrorText } = await import('../js/ai/render.js');
const { t } = await import('../js/ui/i18n.js');
const { CONSENT_VERSION } = await import('../js/ai/consent.js');
appState.meta.ai.consentVersion = CONSENT_VERSION;

const json = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  globalThis.window = { __BUNVELOPE_MODE: { kind: 'cloud' } };
  setServerHasKey(null);
});
afterEach(() => {
  delete globalThis.window;
  vi.unstubAllGlobals();
});

describe('server key status', () => {
  it('no key on the server: AI is unavailable and every feature is off', async () => {
    const f = vi.fn(async () => json(200, { hasKey: false, serverEncryption: null }));
    expect(await loadServerKeyStatus(f)).toBe(false);
    expect(f).toHaveBeenCalledWith('/api/ai/key', expect.objectContaining({ credentials: 'same-origin' }));
    expect(serverKeyMissing()).toBe(true);
    expect(isAiAvailable()).toBe(false);
    expect(isAiFeatureEnabled('search')).toBe(false);
    expect(isAiFeatureEnabled('monthlyBriefing')).toBe(false);
  });

  it('a key on the server: AI is available', async () => {
    await loadServerKeyStatus(async () => json(200, { hasKey: true }));
    expect(isAiAvailable()).toBe(true);
    expect(isAiFeatureEnabled('monthlyBriefing')).toBe(true);
  });

  it('a failed status request leaves it unknown, and AI as available as before', async () => {
    expect(await loadServerKeyStatus(async () => { throw new TypeError('Failed to fetch'); })).toBe(null);
    expect(isAiAvailable()).toBe(true);
    expect(await loadServerKeyStatus(async () => json(500, { error: 'x' }))).toBe(null);
    expect(isAiAvailable()).toBe(true);
  });

  it('a 412 no_user_api_key from an AI call records the key as missing', async () => {
    noteAiError({ code: 'rate_limited' });
    expect(serverKeyMissing()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json(412, { error: 'no_user_api_key' })));
    await expect(aiInsights('monthlyBriefing', { contextOverride: {} })).rejects.toMatchObject({ code: 'no_user_api_key' });
    expect(serverKeyMissing()).toBe(true);
    expect(isAiAvailable()).toBe(false);
  });
});

describe('the one no-key message', () => {
  it('every surface maps no_user_api_key to the same text', () => {
    const err = { code: 'no_user_api_key', status: 412, message: '412 Precondition Failed' };
    expect(aiErrorText(err)).toBe(t('ai.error.noUserApiKey'));
    expect(knownAiErrorText(err)).toBe(t('ai.error.noUserApiKey'));
    expect(t('ai.error.noUserApiKey')).toBe('AI needs an Anthropic API key. Set one in Settings → AI.');
  });

  it('an unknown failure keeps its own message (knownAiErrorText is null)', () => {
    expect(knownAiErrorText({ code: 'http_500', message: 'boom' })).toBe(null);
  });
});
