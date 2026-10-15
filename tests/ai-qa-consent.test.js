// tests/ai-qa-consent.test.js — QA 2026-09-23 #3. isAiAvailable only looked
// at `meta.ai.enabled`, and ensureAiConsent ran only from the setup wizard and
// the Settings toggle, so someone who consented to v1 ("notes are stripped")
// kept sending transaction notes after v2. The transport now asks for fresh
// consent before every request.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const appState = { meta: null, budgetFolder: 'A' };
const confirmDialog = vi.fn();
const saveMeta = vi.fn(async () => {});

vi.mock('../js/app.js', () => ({ state: appState }));
vi.mock('../js/data.js', () => ({ saveMeta: (...a) => saveMeta(...a) }));
vi.mock('../js/ui/dialog.js', () => ({ confirmDialog: (...a) => confirmDialog(...a) }));

const { sendMessages, setConsentGate } = await import('../js/ai/transport.js');
const consent = await import('../js/ai/consent.js');
const { setLocalKey } = await import('../js/ai/keystore.js');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const MSG = [{ role: 'user', content: 'hi' }];
let fetchMock;

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  globalThis.window = {};
  setLocalKey('sk-ant-local');
  fetchMock = vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ id: 'msg_1', content: [] }),
  }));
  globalThis.fetch = fetchMock;
  confirmDialog.mockReset();
  saveMeta.mockClear();
  consent._resetConsentSessionForTest();
  setConsentGate(consent.assertFreshConsent);
});

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.fetch;
});

describe('consent is enforced where requests leave the browser', () => {
  it('sends without asking when consent is current', async () => {
    appState.meta = { ai: { enabled: true, consentVersion: consent.CONSENT_VERSION } };
    await sendMessages({ intent: 'agent', messages: MSG });
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks a v1 consenter again, and sends only after they accept', async () => {
    appState.meta = { ai: { enabled: true, consentVersion: 1 } };
    confirmDialog.mockResolvedValueOnce(true);
    await sendMessages({ intent: 'agent', messages: MSG });
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appState.meta.ai.consentVersion).toBe(consent.CONSENT_VERSION);
    expect(saveMeta).toHaveBeenCalled();
  });

  it('sends nothing when a v1 consenter declines, and does not nag again this session', async () => {
    appState.meta = { ai: { enabled: true, consentVersion: 1 } };
    confirmDialog.mockResolvedValueOnce(false);
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'consent_required' });
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'consent_required' });
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appState.meta.ai.consentVersion).toBe(1);
  });

  it('shows one dialog for concurrent requests', async () => {
    appState.meta = { ai: { enabled: true, consentVersion: 1 } };
    let answer;
    confirmDialog.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const both = Promise.all([
      sendMessages({ intent: 'agent', messages: MSG }),
      sendMessages({ intent: 'agent', messages: MSG }),
    ]);
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    answer(true);
    await both;
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends nothing, and does not prompt, when AI is not enabled at all', async () => {
    appState.meta = { ai: { enabled: false, consentVersion: consent.CONSENT_VERSION } };
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'consent_required' });
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when no gate is installed', async () => {
    appState.meta = { ai: { enabled: true, consentVersion: consent.CONSENT_VERSION } };
    setConsentGate(null);
    await expect(sendMessages({ intent: 'agent', messages: MSG }))
      .rejects.toMatchObject({ code: 'consent_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
