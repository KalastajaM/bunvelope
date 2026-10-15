// @vitest-environment jsdom
// Settings, AI tab and Data & Security tab: what each control writes.
// The AI tab: enable / consent, per-feature switches, model, clear cache, the
// static-mode local key (Test before Save) and the cloud key card, session
// usage, hidden suggestions. The Data & Security tab: export, and the cloud
// encryption controls (enable, change passphrase, disable, resume) plus the
// shared-password dialog.
//
// Nothing leaves the process: every network-facing function is a mock (the AI
// client's key/cache calls, the direct-key test, the storage adapter, the
// crypto and passphrase prompts) and global fetch is stubbed to refuse.
// Drives the real js/pages/settings.js; saveMeta sits behind the meta queue.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));
vi.mock('../js/ai/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  clearAiCache: vi.fn(),
  aiGetKeyStatus: vi.fn(),
  aiSaveKey: vi.fn(),
  aiDeleteKey: vi.fn(),
  aiTestKey: vi.fn(),
}));
vi.mock('../js/ai/transport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  testDirectKey: vi.fn(),
}));
vi.mock('../js/ui/shell.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setNavItemVisible: vi.fn(),
  refreshAiEntryPoints: vi.fn(),
  relabelShell: vi.fn(),
}));
vi.mock('../js/ui/download.js', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadBlob: vi.fn(),
}));
vi.mock('../js/storage/api-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getEncryptionConfig: vi.fn(),
  putEncryptionConfig: vi.fn(),
  flushWrites: vi.fn(),
  setEncryptionKey: vi.fn(),
  setEncryptionRequired: vi.fn(),
}));
vi.mock('../js/storage/crypto.js', async (importOriginal) => ({
  ...(await importOriginal()),
  randomBytes: vi.fn(),
  deriveKey: vi.fn(),
  buildVerifier: vi.fn(),
  bytesToBase64: vi.fn(),
}));
vi.mock('../js/storage/encryption-config.js', () => ({
  unlockDataKey: vi.fn(),
  preparePassphraseChange: vi.fn(),
  convertBudgetEncryption: vi.fn(),
}));
vi.mock('../js/ui/passphrase-prompt.js', () => ({
  promptUnlock: vi.fn(),
  promptSetup: vi.fn(),
  promptChange: vi.fn(),
}));

import { saveMeta } from '../js/data.js';
import { clearAiCache, aiGetKeyStatus, aiSaveKey, aiDeleteKey, aiTestKey } from '../js/ai/client.js';
import { testDirectKey } from '../js/ai/transport.js';
import { CONSENT_VERSION } from '../js/ai/consent.js';
import { AI_MODELS } from '../js/ai/intents.js';
import { recordUsage, resetUsage } from '../js/ai/usage.js';
import { setNavItemVisible, refreshAiEntryPoints } from '../js/ui/shell.js';
import { downloadBlob } from '../js/ui/download.js';
import * as api from '../js/storage/api-adapter.js';
import * as crypto from '../js/storage/crypto.js';
import * as encConfig from '../js/storage/encryption-config.js';
import * as prompts from '../js/ui/passphrase-prompt.js';
import { render } from '../js/pages/settings.js';
import { t } from '../js/ui/i18n.js';
import {
  state, resetState, mountHosts, flush, setValue, dialogOk, dialogButton, toastTexts, topOverlay,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];
const bodyText = () => root().querySelector('#settings-body').textContent;
const hostText = () => document.querySelector('#sheet-host').textContent;
const buttonByText = (label, scope = root()) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const toggleFor = (labelKey) => [...root().querySelectorAll('label.settings-toggle')]
  .find(l => l.textContent.includes(t(labelKey))).querySelector('input[type="checkbox"]');
const enableToggle = () => toggleFor('ai.settings.enable');
const flipTo = async (input, on) => { input.checked = on; input.dispatchEvent(new Event('change', { bubbles: true })); await flush(); };
const click = async (el) => { el.click(); await flush(); };
// The security tab loads through several dynamic imports and awaits.
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const keyInput = () => root().querySelector('input[type="password"]');
const resultText = () => keyInput().closest('.field').parentElement.lastElementChild.textContent;
// This runtime's global localStorage is not the jsdom one, so give the keystore a plain in-memory Storage.
const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
};

async function openTab(tab) {
  mountHosts();
  await render(root());
  await flush();
  root().querySelector(`.content-tab[data-tab="${tab}"]`).click();
  await settle();
}

const setCloud = (extra = {}) => { window.__BUNVELOPE_MODE = { kind: 'cloud', ...extra }; };

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  // Nothing may reach a network: any call that slips past a mock fails loudly.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is blocked in tests'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState();
  state.meta = { name: 'Household' };
  delete window.__BUNVELOPE_MODE;
  vi.stubGlobal('localStorage', memoryStorage());
  resetUsage();
  for (const fn of [
    saveMeta, clearAiCache, aiGetKeyStatus, aiSaveKey, aiDeleteKey, aiTestKey, testDirectKey,
    setNavItemVisible, refreshAiEntryPoints, downloadBlob,
    api.getEncryptionConfig, api.putEncryptionConfig, api.flushWrites, api.setEncryptionKey, api.setEncryptionRequired,
    crypto.randomBytes, crypto.deriveKey, crypto.buildVerifier, crypto.bytesToBase64,
    encConfig.unlockDataKey, encConfig.preparePassphraseChange, encConfig.convertBudgetEncryption,
    prompts.promptUnlock, prompts.promptSetup, prompts.promptChange,
  ]) fn.mockReset();
  saveMeta.mockImplementation(async () => {});
});

afterEach(() => { delete window.__BUNVELOPE_MODE; });

// ── AI tab, static mode ───────────────────────────────────────────────────

describe('AI tab: enabling and consent', () => {
  it('turning it on asks for consent, then writes enabled with the consent version and default flags', async () => {
    await openTab('ai');
    expect(enableToggle().checked).toBe(false);
    await flipTo(enableToggle(), true);
    // Static mode names the browser-to-Anthropic route in the disclosure.
    expect(topOverlay().textContent).toContain(t('ai.consent.bodyLocal'));
    expect(saveMeta).not.toHaveBeenCalled();
    dialogOk().click();
    await flush();

    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(saveMeta.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(savedMeta().name).toBe('Household');
    expect(savedMeta().ai).toMatchObject({ enabled: true, consentVersion: CONSENT_VERSION });
    expect(Object.values(savedMeta().ai.perFeature).every(v => v === true)).toBe(true);
    expect(setNavItemVisible).toHaveBeenCalledWith('insights', false);
    expect(refreshAiEntryPoints).toHaveBeenCalled();
    // The tab repainted from the new state.
    expect(enableToggle().checked).toBe(true);
    expect(bodyText()).toContain(t('ai.settings.enabled'));
  });

  it('declining consent writes nothing and puts the switch back', async () => {
    await openTab('ai');
    await flipTo(enableToggle(), true);
    dialogButton(t('ai.consent.decline')).click();
    await flush();
    expect(saveMeta).not.toHaveBeenCalled();
    expect(enableToggle().checked).toBe(false);
  });

  it('turning it off keeps the rest of meta.ai and stores enabled: false', async () => {
    state.meta = { ai: { enabled: true, consentVersion: CONSENT_VERSION, model: AI_MODELS.haiku } };
    await openTab('ai');
    await flipTo(enableToggle(), false);
    expect(savedMeta().ai).toEqual({ enabled: false, consentVersion: CONSENT_VERSION, model: AI_MODELS.haiku });
    expect(enableToggle().checked).toBe(false);
  });

  it('a failed write puts the switch back', async () => {
    saveMeta.mockRejectedValueOnce(new Error('offline'));
    await openTab('ai');
    await flipTo(enableToggle(), true);
    dialogOk().click();
    await flush();
    expect(enableToggle().checked).toBe(false);
    expect(state.meta.ai).toBeUndefined();
  });

  it('static mode shows no per-feature switches, only the privacy note', async () => {
    await openTab('ai');
    expect(bodyText()).not.toContain(t('ai.settings.perFeatureTitle'));
    expect(bodyText()).toContain(t('ai.settings.privacyTitle'));
  });
});

describe('AI tab: the local API key (static mode)', () => {
  const FAKE_KEY = 'sk-ant-test-0123456789abcdefghij';

  beforeEach(async () => { await openTab('ai'); });

  it('starts as not set, with Save locked and no Remove button', () => {
    expect(bodyText()).toContain(t('ai.settings.apiKeyNotSet'));
    expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);
    expect(buttonByText(t('ai.settings.apiKeyRemove')).style.display).toBe('none');
  });

  it('testing an empty box asks for a key and tests nothing', async () => {
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    expect(resultText()).toBe(t('ai.settings.apiKeyEnterFirst'));
    expect(testDirectKey).not.toHaveBeenCalled();
  });

  it('Save unlocks only after Test passes for the exact value, then stores the trimmed key', async () => {
    testDirectKey.mockResolvedValue({ ok: true });
    setValue(keyInput(), `  ${FAKE_KEY}  `, ['input']);
    expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    expect(testDirectKey).toHaveBeenCalledWith(FAKE_KEY);
    expect(resultText()).toBe(t('ai.settings.apiKeyTestOk'));
    expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(false);
    // Nothing is stored by testing.
    expect(localStorage.getItem('bv.ai.key')).toBeNull();

    // Editing the box locks Save again.
    setValue(keyInput(), `${FAKE_KEY}x`, ['input']);
    expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);
    // A forced click still refuses: the value is not the one that passed.
    buttonByText(t('ai.settings.apiKeySave')).click();
    await flush();
    expect(localStorage.getItem('bv.ai.key')).toBeNull();

    setValue(keyInput(), FAKE_KEY, ['input']);
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    await click(buttonByText(t('ai.settings.apiKeySave')));
    expect(localStorage.getItem('bv.ai.key')).toBe(FAKE_KEY);
    expect(toastTexts()).toContain(t('ai.settings.apiKeySaved'));
    expect(refreshAiEntryPoints).toHaveBeenCalled();
    // The repainted card shows the masked key, never the key.
    expect(bodyText()).toContain(t('ai.settings.apiKeyConfigured'));
    expect(bodyText()).not.toContain(FAKE_KEY);
    // The key lives in the browser, not in the budget's meta.
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('a network failure is not blamed on the key; a rejected key is; nothing unlocks', async () => {
    setValue(keyInput(), FAKE_KEY, ['input']);
    testDirectKey.mockResolvedValueOnce({ ok: false, code: 'network' });
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    expect(resultText()).toBe(t('ai.settings.localKeyNetworkFail'));
    testDirectKey.mockResolvedValueOnce({ ok: false, code: 'invalid_api_key' });
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    expect(resultText()).toBe(t('ai.settings.apiKeyTestFail'));
    testDirectKey.mockRejectedValueOnce(new Error('boom'));
    await click(buttonByText(t('ai.settings.apiKeyTest')));
    expect(resultText()).toBe(t('ai.settings.apiKeyTestFail'));
    expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);
  });

  it('Remove asks first, then clears the stored key', async () => {
    localStorage.setItem('bv.ai.key', FAKE_KEY);
    await openTab('ai');
    expect(bodyText()).toContain(t('ai.settings.apiKeyConfigured'));
    await click(buttonByText(t('ai.settings.apiKeyRemove')));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(localStorage.getItem('bv.ai.key')).toBe(FAKE_KEY);

    await click(buttonByText(t('ai.settings.apiKeyRemove')));
    dialogOk().click();
    await flush();
    expect(localStorage.getItem('bv.ai.key')).toBeNull();
    expect(toastTexts()).toContain(t('ai.settings.apiKeyRemoved'));
    expect(bodyText()).toContain(t('ai.settings.apiKeyNotSet'));
  });
});

describe('AI tab: session usage', () => {
  it('is empty until something has been spent', async () => {
    await openTab('ai');
    expect(bodyText()).toContain(t('ai.settings.usageEmpty'));
    expect(buttonByText(t('ai.settings.usageReset'))).toBeUndefined();
  });

  it('shows the totals, and Reset clears them without writing anything', async () => {
    recordUsage({ model: AI_MODELS.haiku, usage: { input_tokens: 1500, output_tokens: 250 } });
    recordUsage({ model: AI_MODELS.haiku, usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 2000 } });
    await openTab('ai');
    const grid = root().querySelector('.ai-usage-grid');
    const stat = (labelKey) => [...grid.querySelectorAll('.ai-usage-stat')]
      .find(s => s.textContent.startsWith(t(labelKey))).querySelector('.ai-usage-value').textContent;
    expect(stat('ai.settings.usageCalls')).toBe('2');
    expect(stat('ai.settings.usageOut')).toBe('300');
    expect(stat('ai.settings.usageIn')).toBe('4.0k');
    await click(buttonByText(t('ai.settings.usageReset')));
    expect(bodyText()).toContain(t('ai.settings.usageEmpty'));
    expect(saveMeta).not.toHaveBeenCalled();
  });
});

// ── AI tab, cloud mode ───────────────────────────────────────────────────

describe('AI tab: cloud mode', () => {
  beforeEach(() => {
    setCloud();
    aiGetKeyStatus.mockResolvedValue({ hasKey: false, serverEncryption: 'aes-256-gcm' });
  });

  it('turning it on states the relay disclosure and opens the insight cards', async () => {
    await openTab('ai');
    await flipTo(enableToggle(), true);
    expect(topOverlay().textContent).toContain(t('ai.consent.body'));
    dialogOk().click();
    await flush();
    expect(savedMeta().ai.enabled).toBe(true);
    expect(savedMeta().ai.consentVersion).toBe(CONSENT_VERSION);
    // Cloud, signed in: the relay features are available now.
    expect(setNavItemVisible).toHaveBeenCalledWith('insights', true);
  });

  it('a cloud guest has no AI tab at all', async () => {
    state.budgetFolder = { name: 'guest', __guest: true };
    mountHosts();
    await render(root());
    expect(root().querySelector('.content-tab[data-tab="ai"]')).toBeNull();
  });

  describe('once enabled', () => {
    beforeEach(() => {
      state.meta = { ai: { enabled: true, consentVersion: CONSENT_VERSION } };
    });

    it('a per-feature switch writes that flag and keeps the others on', async () => {
      await openTab('ai');
      await flipTo(toggleFor('ai.search.button'), false);
      expect(savedMeta().ai.perFeature.search).toBe(false);
      expect(savedMeta().ai.perFeature.anomaly).toBe(true);
      expect(savedMeta().ai.enabled).toBe(true);
      await flipTo(toggleFor('ai.search.button'), true);
      expect(savedMeta().ai.perFeature.search).toBe(true);
    });

    it('a failed write puts the per-feature switch back', async () => {
      saveMeta.mockRejectedValueOnce(new Error('offline'));
      await openTab('ai');
      await flipTo(toggleFor('ai.whatif.title'), false);
      expect(toggleFor('ai.whatif.title').checked).toBe(true);
      expect(state.meta.ai.perFeature).toBeUndefined();
    });

    it('the model choice is stored, and Default removes it', async () => {
      await openTab('ai');
      const select = root().querySelector('details select');
      expect([...select.options].map(o => o.value)).toEqual(['', AI_MODELS.haiku, AI_MODELS.sonnet]);
      setValue(select, AI_MODELS.sonnet, ['change']);
      await flush();
      expect(savedMeta().ai.model).toBe(AI_MODELS.sonnet);
      setValue(root().querySelector('details select'), '', ['change']);
      await flush();
      expect(savedMeta().ai).not.toHaveProperty('model');
      expect(savedMeta().ai.enabled).toBe(true);
    });

    it('a model saved before a model moved on shows as its tier\'s current model', async () => {
      state.meta = { ai: { enabled: true, consentVersion: CONSENT_VERSION, model: 'claude-sonnet-4-6' } };
      await openTab('ai');
      expect(root().querySelector('details select').value).toBe(AI_MODELS.sonnet);
    });

    it('Clear cache calls the server once and confirms; a failure says so', async () => {
      clearAiCache.mockResolvedValueOnce({});
      await openTab('ai');
      const btn = buttonByText(t('ai.settings.clearCache'));
      await click(btn);
      expect(clearAiCache).toHaveBeenCalledTimes(1);
      expect(toastTexts()).toContain(t('ai.settings.cacheCleared'));
      expect(btn.disabled).toBe(false);

      clearAiCache.mockRejectedValueOnce(new Error('500'));
      await click(btn);
      expect(toastTexts()).toContain(t('ai.error.generic'));
    });
  });

  describe('while disabled', () => {
    it('the per-feature switches, model and cache button are locked', async () => {
      await openTab('ai');
      expect(toggleFor('ai.search.button').disabled).toBe(true);
      expect(root().querySelector('details select').disabled).toBe(true);
      expect(buttonByText(t('ai.settings.clearCache')).disabled).toBe(true);
    });
  });

  describe('the server-side key', () => {
    const FAKE_KEY = 'sk-ant-test-0123456789abcdefghij';
    beforeEach(() => { state.meta = { ai: { enabled: true, consentVersion: CONSENT_VERSION } }; });

    it('reports the key status from the server, with the encryption note', async () => {
      aiGetKeyStatus.mockResolvedValue({ hasKey: true, preview: 'abcd', setAt: '2026-09-01T10:00:00Z', serverEncryption: 'aes-256-gcm' });
      await openTab('ai');
      expect(bodyText()).toContain(t('ai.settings.apiKeyConfigured'));
      expect(bodyText()).toContain('…abcd');
      expect(bodyText()).toContain('2026-09-01');
      expect(bodyText()).toContain(t('ai.settings.apiKeyEncryptionOk'));
      expect(buttonByText(t('ai.settings.apiKeyRemove')).style.display).toBe('');
    });

    it('warns when the server does not encrypt keys at rest', async () => {
      aiGetKeyStatus.mockResolvedValue({ hasKey: false, serverEncryption: 'none' });
      await openTab('ai');
      expect(bodyText()).toContain(t('ai.settings.apiKeyEncryptionWarning'));
      expect(bodyText()).toContain(t('ai.settings.apiKeyNotSet'));
    });

    it('a failed status load is reported', async () => {
      aiGetKeyStatus.mockRejectedValue(new Error('down'));
      await openTab('ai');
      expect(bodyText()).toContain(t('ai.error.generic'));
    });

    it('Test then Save sends the trimmed key to the server, never to meta', async () => {
      aiTestKey.mockResolvedValue({ ok: true });
      aiSaveKey.mockResolvedValue({});
      await openTab('ai');
      setValue(keyInput(), ` ${FAKE_KEY} `, ['input']);
      expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);
      await click(buttonByText(t('ai.settings.apiKeyTest')));
      expect(aiTestKey).toHaveBeenCalledWith(FAKE_KEY);
      expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(false);
      expect(aiSaveKey).not.toHaveBeenCalled();
      await click(buttonByText(t('ai.settings.apiKeySave')));
      expect(aiSaveKey).toHaveBeenCalledWith(FAKE_KEY);
      expect(toastTexts()).toContain(t('ai.settings.apiKeySaved'));
      // A saved key can turn the AI entry points on: they are re-checked.
      expect(refreshAiEntryPoints).toHaveBeenCalled();
      expect(setNavItemVisible).toHaveBeenCalledWith('insights', expect.any(Boolean));
      expect(saveMeta).not.toHaveBeenCalled();
      expect(localStorage.getItem('bv.ai.key')).toBeNull();
    });

    it('a rejected key, a malformed key and a failed save each say what happened', async () => {
      await openTab('ai');
      setValue(keyInput(), FAKE_KEY, ['input']);
      aiTestKey.mockResolvedValueOnce({ ok: false, code: 'invalid_user_api_key' });
      await click(buttonByText(t('ai.settings.apiKeyTest')));
      expect(resultText()).toBe(t('ai.settings.apiKeyTestInvalid'));
      aiTestKey.mockResolvedValueOnce({ ok: false, code: 'other' });
      await click(buttonByText(t('ai.settings.apiKeyTest')));
      expect(resultText()).toBe(t('ai.settings.apiKeyTestFail'));
      aiTestKey.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'bad_api_key' }));
      await click(buttonByText(t('ai.settings.apiKeyTest')));
      expect(resultText()).toBe(t('ai.settings.apiKeyTestBadShape'));
      expect(buttonByText(t('ai.settings.apiKeySave')).disabled).toBe(true);

      aiTestKey.mockResolvedValueOnce({ ok: true });
      await click(buttonByText(t('ai.settings.apiKeyTest')));
      aiSaveKey.mockRejectedValueOnce(new Error('500'));
      await click(buttonByText(t('ai.settings.apiKeySave')));
      expect(toastTexts()).toContain(t('ai.error.generic'));
    });

    it('Remove asks first, then deletes the server key', async () => {
      aiGetKeyStatus.mockResolvedValue({ hasKey: true, preview: 'abcd', serverEncryption: 'aes-256-gcm' });
      aiDeleteKey.mockResolvedValue({});
      await openTab('ai');
      await click(buttonByText(t('ai.settings.apiKeyRemove')));
      dialogButton(t('common.cancel')).click();
      await flush();
      expect(aiDeleteKey).not.toHaveBeenCalled();
      await click(buttonByText(t('ai.settings.apiKeyRemove')));
      dialogOk().click();
      await flush();
      expect(aiDeleteKey).toHaveBeenCalledTimes(1);
      expect(toastTexts()).toContain(t('ai.settings.apiKeyRemoved'));
      expect(refreshAiEntryPoints).toHaveBeenCalled();
    });
  });

  describe('hidden suggestions', () => {
    beforeEach(() => {
      state.meta = {
        ai: {
          enabled: true, consentVersion: CONSENT_VERSION,
          dismissed: {
            subscription: {
              Netflix: { dismissedAt: '2026-09-02T00:00:00.000Z', label: 'Netflix' },
              Spotify: { dismissedAt: '2026-09-01T00:00:00.000Z', label: 'Spotify' },
            },
            anomaly: { 'a-1': { dismissedAt: '2026-09-03T00:00:00.000Z', label: 'Odd spend' } },
          },
          dismissedSubs: ['Netflix', 'Spotify'],
        },
      };
    });
    const dismissedCard = () => [...root().querySelectorAll('.card')]
      .find(c => c.querySelector('h3')?.textContent === t('ai.settings.dismissedTitle'));

    it('lists dismissed items by feature, newest first', async () => {
      await openTab('ai');
      const text = dismissedCard().textContent;
      expect(text).toContain('Netflix');
      expect(text).toContain('Odd spend');
      expect(text.indexOf('Odd spend')).toBeLessThan(text.indexOf('Netflix'));
      expect(text.indexOf('Netflix')).toBeLessThan(text.indexOf('Spotify'));
    });

    it('Restore removes just that item, and its legacy mirror', async () => {
      await openTab('ai');
      const row = [...dismissedCard().querySelectorAll('div')]
        .find(d => d.children.length === 3 && d.textContent.startsWith('Netflix'));
      await click(buttonByText(t('ai.settings.dismissedRestore'), row));
      expect(savedMeta().ai.dismissed.subscription).toEqual({ Spotify: { dismissedAt: '2026-09-01T00:00:00.000Z', label: 'Spotify' } });
      expect(savedMeta().ai.dismissed.anomaly).toBeDefined();
      expect(savedMeta().ai.dismissedSubs).toEqual(['Spotify']);
      expect(dismissedCard().textContent).not.toContain('Netflix');
    });

    it('Clear all removes a whole feature and leaves the others', async () => {
      await openTab('ai');
      const heading = [...dismissedCard().querySelectorAll('div')]
        .find(d => d.firstElementChild?.tagName === 'SPAN' && d.textContent.includes(t('ai.dismissed.feature.subscription')));
      await click(buttonByText(t('ai.settings.dismissedClearAll'), heading));
      expect(savedMeta().ai.dismissed).not.toHaveProperty('subscription');
      expect(savedMeta().ai.dismissed.anomaly).toBeDefined();
      expect(savedMeta().ai.dismissedSubs).toEqual([]);
    });
  });
});

// ── Data & Security tab ──────────────────────────────────────────────────

describe('Data & Security tab: export', () => {
  it('builds a zip named for the budget and today, and hands it to the download', async () => {
    await openTab('security');
    await click(root().querySelector('#settings-export-zip'));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [name, blob] = downloadBlob.mock.calls[0];
    expect(name).toMatch(/^bunvelope-.*-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(root().querySelector('#settings-data-status').textContent).toBe(t('settings.export.exported'));
    expect(root().querySelector('#settings-export-zip').disabled).toBe(false);
    // Exporting reads the budget; it writes nothing.
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('a failing download reports the error and re-enables the button', async () => {
    downloadBlob.mockImplementationOnce(() => { throw new Error('blocked'); });
    await openTab('security');
    await click(root().querySelector('#settings-export-zip'));
    expect(root().querySelector('#settings-data-status').textContent).toBe(t('settings.export.failed')('blocked'));
    expect(root().querySelector('#settings-export-zip').disabled).toBe(false);
  });
});

describe('Data & Security tab: encryption availability', () => {
  it('outside cloud mode it says encryption is cloud-only and offers no controls', async () => {
    await openTab('security');
    expect(bodyText()).toContain(t('security.tab.cloudOnly'));
    expect(buttonByText(t('security.tab.enable'))).toBeUndefined();
    expect(api.getEncryptionConfig).not.toHaveBeenCalled();
  });

  it('a cloud guest is told to sign in', async () => {
    setCloud();
    state.budgetFolder = { name: 'guest', __guest: true };
    await openTab('security');
    expect(bodyText()).toContain(t('security.tab.guestOnly'));
    expect(api.getEncryptionConfig).not.toHaveBeenCalled();
  });
});

describe('Data & Security tab: encryption controls (cloud)', () => {
  // A shared log so the ORDER of the calls, which is what makes these flows
  // safe to interrupt, can be asserted.
  let order;
  const log = (name, impl = async () => {}) => (...args) => { order.push(name); return impl(...args); };
  const CFG_ON = { enabled: true, salt: 'SALT64', verifier: { keyId: 'SALT64' } };
  const status = () => root().querySelector('#settings-body .card:last-of-type div:last-child').textContent;

  beforeEach(() => {
    setCloud();
    order = [];
    api.flushWrites.mockImplementation(log('flush'));
    api.setEncryptionKey.mockImplementation(log('setKey'));
    api.setEncryptionRequired.mockImplementation(log('setRequired'));
    api.putEncryptionConfig.mockImplementation(log('putConfig'));
    encConfig.convertBudgetEncryption.mockImplementation(log('convert'));
    crypto.randomBytes.mockReturnValue(new Uint8Array(16));
    crypto.deriveKey.mockResolvedValue('DERIVED-KEY');
    crypto.buildVerifier.mockImplementation(async () => ({ check: 'v' }));
    crypto.bytesToBase64.mockReturnValue('SALT64');
  });

  describe('when it is off', () => {
    beforeEach(() => { api.getEncryptionConfig.mockResolvedValue({ enabled: false }); });

    it('shows the disabled state with an Enable button', async () => {
      await openTab('security');
      expect(bodyText()).toContain(t('security.tab.disabled'));
      expect(buttonByText(t('security.tab.enable'))).toBeTruthy();
      expect(buttonByText(t('security.tab.disable'))).toBeUndefined();
    });

    it('cancelling the passphrase prompt changes nothing', async () => {
      prompts.promptSetup.mockResolvedValue(null);
      await openTab('security');
      await click(buttonByText(t('security.tab.enable')));
      await settle();
      expect(order).toEqual([]);
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
    });

    it('Enable names the key before encrypting anything, then converts every budget', async () => {
      prompts.promptSetup.mockResolvedValue('test-passphrase-1');
      await openTab('security');
      await click(buttonByText(t('security.tab.enable')));
      await settle();

      expect(crypto.deriveKey).toHaveBeenCalledWith('test-passphrase-1', expect.any(Uint8Array));
      // Config first, conversion after: doing it the other way round locks the user out.
      expect(order).toEqual(['flush', 'setKey', 'setRequired', 'putConfig', 'convert']);
      expect(api.setEncryptionKey).toHaveBeenCalledWith('DERIVED-KEY', 'SALT64');
      expect(api.setEncryptionRequired).toHaveBeenCalledWith(true);
      expect(api.putEncryptionConfig).toHaveBeenCalledWith(
        { enabled: true, salt: 'SALT64', verifier: { check: 'v', keyId: 'SALT64' } },
        { enabled: false },
      );
      expect(encConfig.convertBudgetEncryption).toHaveBeenCalledWith(api, 'DERIVED-KEY', expect.any(Function));
      expect(status()).toBe(t('security.status.done'));
      // The passphrase itself is never handed to the storage adapter.
      expect(JSON.stringify(api.putEncryptionConfig.mock.calls)).not.toContain('test-passphrase-1');
    });

    it('a failed conversion says so, and the config stays as written', async () => {
      prompts.promptSetup.mockResolvedValue('test-passphrase-1');
      encConfig.convertBudgetEncryption.mockImplementation(async () => { throw new Error('half done'); });
      await openTab('security');
      await click(buttonByText(t('security.tab.enable')));
      await settle();
      expect(hostText()).toContain(t('security.err.enablePartial'));
      expect(status()).toBe(t('security.err.failed'));
      expect(api.putEncryptionConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('when it is on', () => {
    beforeEach(() => { api.getEncryptionConfig.mockResolvedValue(CFG_ON); });

    it('shows Change and Disable, and no Resume', async () => {
      await openTab('security');
      expect(bodyText()).toContain(t('security.tab.enabled'));
      expect(buttonByText(t('security.tab.change'))).toBeTruthy();
      expect(buttonByText(t('security.tab.disable'))).toBeTruthy();
      expect(buttonByText(t('security.tab.resume'))).toBeUndefined();
    });

    it('Change writes the re-wrapped config against the current one, then re-reads it', async () => {
      prompts.promptChange.mockResolvedValue({ oldPassphrase: 'old-test-pass', newPassphrase: 'new-test-pass' });
      const next = { enabled: true, salt: 'SALT64', wrapped: 'NEW' };
      encConfig.preparePassphraseChange.mockResolvedValue(next);
      await openTab('security');
      api.getEncryptionConfig.mockClear();
      await click(buttonByText(t('security.tab.change')));
      await settle();
      expect(encConfig.preparePassphraseChange).toHaveBeenCalledWith(CFG_ON, 'old-test-pass', 'new-test-pass');
      expect(api.putEncryptionConfig).toHaveBeenCalledWith(next, CFG_ON);
      expect(order).toEqual(['flush', 'putConfig']);
      expect(status()).toBe(t('security.status.done'));
      expect(api.getEncryptionConfig).toHaveBeenCalledTimes(1);
      // Changing the passphrase never re-encrypts the budgets: same data key.
      expect(encConfig.convertBudgetEncryption).not.toHaveBeenCalled();
    });

    it('cancelling the change prompt changes nothing', async () => {
      prompts.promptChange.mockResolvedValue(null);
      await openTab('security');
      await click(buttonByText(t('security.tab.change')));
      await settle();
      expect(encConfig.preparePassphraseChange).not.toHaveBeenCalled();
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
    });

    it('a failed change does not claim a rollback it cannot confirm', async () => {
      prompts.promptChange.mockResolvedValue({ oldPassphrase: 'old-test-pass', newPassphrase: 'new-test-pass' });
      encConfig.preparePassphraseChange.mockRejectedValue(new Error('wrong old'));
      await openTab('security');
      await click(buttonByText(t('security.tab.change')));
      await settle();
      expect(hostText()).toContain(t('security.err.changeUncertain'));
      expect(status()).toBe(t('security.err.failed'));
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
      // Once the alert is dismissed the card re-reads the config and the button is live again.
      dialogOk().click();
      await settle();
      expect(buttonByText(t('security.tab.change')).disabled).toBe(false);
    });

    it('Disable asks, checks the passphrase, decrypts every budget, and turns the config off LAST', async () => {
      prompts.promptUnlock.mockResolvedValue('old-test-pass');
      encConfig.unlockDataKey.mockResolvedValue('OLD-KEY');
      await openTab('security');
      await click(buttonByText(t('security.tab.disable')));
      expect(topOverlay().textContent).toContain(t('security.disable.confirm'));
      dialogOk().click();
      await settle();

      expect(encConfig.unlockDataKey).toHaveBeenCalledWith(CFG_ON, 'old-test-pass');
      expect(api.setEncryptionKey.mock.calls[0]).toEqual(['OLD-KEY', 'SALT64']);
      expect(encConfig.convertBudgetEncryption).toHaveBeenCalledWith(api, null, expect.any(Function));
      expect(api.putEncryptionConfig).toHaveBeenCalledWith({ enabled: false }, CFG_ON);
      // The old key stays named until every blob is decrypted; the config goes last.
      expect(order).toEqual(['setKey', 'setRequired', 'convert', 'putConfig', 'setKey', 'setRequired']);
      expect(api.setEncryptionKey.mock.calls[1]).toEqual([null]);
      expect(api.setEncryptionRequired.mock.calls.map(c => c[0])).toEqual([true, false]);
    });

    it('declining the confirmation, or cancelling the prompt, does nothing', async () => {
      await openTab('security');
      await click(buttonByText(t('security.tab.disable')));
      dialogButton(t('common.cancel')).click();
      await settle();
      expect(prompts.promptUnlock).not.toHaveBeenCalled();

      prompts.promptUnlock.mockResolvedValue(null);
      await click(buttonByText(t('security.tab.disable')));
      dialogOk().click();
      await settle();
      expect(encConfig.unlockDataKey).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });

    it('a wrong passphrase stops before any key is set or budget touched', async () => {
      prompts.promptUnlock.mockResolvedValue('nope');
      encConfig.unlockDataKey.mockResolvedValue(null);
      await openTab('security');
      await click(buttonByText(t('security.tab.disable')));
      dialogOk().click();
      await settle();
      expect(hostText()).toContain(t('security.err.wrongPassphrase'));
      expect(order).toEqual([]);
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
    });

    it('a failure part-way leaves the config naming the passphrase, and says to run Disable again', async () => {
      prompts.promptUnlock.mockResolvedValue('old-test-pass');
      encConfig.unlockDataKey.mockResolvedValue('OLD-KEY');
      encConfig.convertBudgetEncryption.mockImplementation(async () => { throw new Error('half'); });
      await openTab('security');
      await click(buttonByText(t('security.tab.disable')));
      dialogOk().click();
      await settle();
      expect(hostText()).toContain(t('security.err.disablePartial'));
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
    });
  });

  describe('when it was left half done', () => {
    beforeEach(() => { api.getEncryptionConfig.mockResolvedValue({ ...CFG_ON, incomplete: true }); });

    it('offers Finish encryption, which converts with the unlocked key', async () => {
      prompts.promptUnlock.mockResolvedValue('test-passphrase-1');
      encConfig.unlockDataKey.mockResolvedValue('DATA-KEY');
      await openTab('security');
      expect(bodyText()).toContain(t('security.tab.incomplete'));
      await click(buttonByText(t('security.tab.resume')));
      await settle();
      expect(order).toEqual(['flush', 'setKey', 'setRequired', 'convert']);
      expect(api.setEncryptionKey).toHaveBeenCalledWith('DATA-KEY', 'SALT64');
      expect(encConfig.convertBudgetEncryption).toHaveBeenCalledWith(api, 'DATA-KEY', expect.any(Function));
      // Finishing never rewrites the config: it already names the key.
      expect(api.putEncryptionConfig).not.toHaveBeenCalled();
    });

    it('a wrong passphrase converts nothing', async () => {
      prompts.promptUnlock.mockResolvedValue('nope');
      encConfig.unlockDataKey.mockResolvedValue(null);
      await openTab('security');
      await click(buttonByText(t('security.tab.resume')));
      await settle();
      expect(hostText()).toContain(t('security.err.wrongPassphrase'));
      expect(order).toEqual([]);
    });
  });

  it('a failed config load is reported on the card', async () => {
    api.getEncryptionConfig.mockRejectedValue(new Error('down'));
    await openTab('security');
    expect(status()).toBe(t('security.err.failed'));
  });
});

describe('Data & Security tab: shared password (bypass mode)', () => {
  const inputs = () => [...document.querySelectorAll('#sheet-host input[type="password"]')];
  const submit = () => buttonByText(t('auth.changePasswordSubmit'), document.querySelector('#sheet-host'));
  const errText = () => document.querySelector('#sheet-host p[style*="danger"]').textContent;
  const CURRENT = 'current-test-pass';
  const NEXT = 'a-brand-new-test-password';

  beforeEach(async () => {
    setCloud({ bypassGoogle: true });
    api.getEncryptionConfig.mockResolvedValue({ enabled: false });
    await openTab('security');
    await click(buttonByText(t('settings.bypassPassword.changeButton')));
    await settle();
  });

  const fill = (current, next, again) => {
    setValue(inputs()[0], current, ['input']);
    setValue(inputs()[1], next, ['input']);
    setValue(inputs()[2], again, ['input']);
  };

  it('is offered only in bypass mode', async () => {
    setCloud();
    await openTab('security');
    expect(buttonByText(t('settings.bypassPassword.changeButton'))).toBeUndefined();
  });

  it('a short new password is refused before anything is sent', async () => {
    fill(CURRENT, 'short', 'short');
    await click(submit());
    expect(errText()).toBe(t('auth.changePasswordTooShort'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a mismatched confirmation is refused before anything is sent', async () => {
    fill(CURRENT, NEXT, `${NEXT}x`);
    await click(submit());
    expect(errText()).toBe(t('auth.changePasswordMismatch'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the current and new password once, then closes and confirms', async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    fill(CURRENT, NEXT, NEXT);
    await click(submit());
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/auth/password/change');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ current: CURRENT, new: NEXT });
    expect(toastTexts()).toContain(t('settings.bypassPassword.success'));
    expect(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]')).toBeNull();
  });

  it.each([
    [401, {}, () => t('settings.bypassPassword.wrongCurrent')],
    [429, {}, () => t('auth.bypassRateLimited')],
    [400, { error: 'password_too_short' }, () => t('auth.changePasswordTooShort')],
    [500, {}, () => t('auth.changePasswordFailed')],
  ])('a %i response keeps the dialog open with the matching message', async (status, body, message) => {
    fetch.mockResolvedValueOnce({ ok: false, status, json: async () => body });
    fill(CURRENT, NEXT, NEXT);
    await click(submit());
    expect(errText()).toBe(message());
    expect(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]')).not.toBeNull();
  });

  it('a network error keeps the dialog open with the generic message', async () => {
    fill(CURRENT, NEXT, NEXT);
    await click(submit());
    expect(errText()).toBe(t('auth.changePasswordFailed'));
    expect(submit().disabled).toBe(false);
  });
});
