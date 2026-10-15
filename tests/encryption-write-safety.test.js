// tests/encryption-write-safety.test.js
//
// Guards the two halves of a CRITICAL data-loss defect found on 2026-08-26.
//
// 1. FAIL CLOSED. `maybeEncrypt` returned the data untouched whenever no key
//    was loaded. For an account with encryption switched ON that silently
//    wrote the budget to the server in the clear — a privacy failure with no
//    symptom at all. It was reachable: the sign-in unlock flow swallowed its
//    own errors and let the session continue keyless, and a brand-new budget
//    has no encrypted blobs to trip over, so the setup wizard just wrote
//    plaintext.
//
// 2. ORDERING. The rule the enable/disable/change flows must obey is:
//
//      the stored config must, at every instant, name a key that can read
//      every blob that is currently encrypted.
//
//    It works because `maybeDecrypt` passes plaintext through untouched, so a
//    PARTLY re-keyed budget set stays fully readable as long as the named key
//    opens the encrypted subset. Enable must therefore write the config
//    FIRST, and Disable must write it LAST. Enable had it backwards, and the
//    comment above it claimed the opposite of what the code did — a failure
//    between the loop and the config write left every budget encrypted while
//    the server said `enabled: false`, so sign-in never prompted, no key was
//    ever loaded, and every blob threw. No in-app way back.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as api from '../js/storage/api-adapter.js';
import { deriveKey, randomBytes, isEncrypted } from '../js/storage/crypto.js';

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body = {} } = (await handler(url, opts)) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

/** The payload the client actually PUT for a given collection. */
function putBody(calls, kind) {
  const call = calls.find(
    (c) => c.opts?.method === 'PUT' && c.url.includes(`/collections/${kind}`),
  );
  return call ? JSON.parse(call.opts.body) : null;
}

describe('encryption write safety', () => {
  beforeEach(() => {
    globalThis.fetch = undefined;
    api.setEncryptionKey(null);
    api.setEncryptionRequired(false);
  });

  afterEach(() => {
    api.setEncryptionKey(null);
    api.setEncryptionRequired(false);
  });

  // ── 1. Fail closed ──────────────────────────────────────────────────────

  it('refuses to write when encryption is required but no key is loaded', async () => {
    stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    api.setEncryptionRequired(true);
    api.setEncryptionKey(null);

    const ref = { kind: 'cloud', budgetId: 'b1', version: 1 };
    await expect(api.saveEnvelopes(ref, [{ id: 'e1', name: 'Food' }]))
      .rejects.toThrow(/no key is loaded/i);
  });

  it('does not reach the network at all in that state', async () => {
    // The point is that nothing plaintext leaves the machine — not merely
    // that the promise rejects after the PUT has already gone out.
    const calls = stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    api.setEncryptionRequired(true);
    api.setEncryptionKey(null);

    const ref = { kind: 'cloud', budgetId: 'b1', version: 1 };
    await expect(api.saveEnvelopes(ref, [{ id: 'e1', name: 'Food' }])).rejects.toThrow();
    expect(calls.filter((c) => c.opts?.method === 'PUT')).toHaveLength(0);
  });

  it('still writes plaintext when encryption is genuinely off', async () => {
    // The guard must not break accounts that never enabled encryption, nor
    // the disable flow, which lowers `required` on purpose to write plaintext.
    const calls = stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    api.setEncryptionRequired(false);
    api.setEncryptionKey(null);

    const ref = { kind: 'cloud', budgetId: 'b1', version: 1 };
    await api.saveEnvelopes(ref, [{ id: 'e1', name: 'Food' }]);

    const body = putBody(calls, 'envelopes');
    expect(isEncrypted(body.data)).toBe(false);
    expect(body.data[0].name).toBe('Food');
  });

  it('encrypts when a key is loaded', async () => {
    const calls = stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    const key = await deriveKey('correct horse battery staple', randomBytes(16));
    api.setEncryptionRequired(true);
    api.setEncryptionKey(key);

    const ref = { kind: 'cloud', budgetId: 'b1', version: 1 };
    await api.saveEnvelopes(ref, [{ id: 'e1', name: 'Food' }]);

    const body = putBody(calls, 'envelopes');
    expect(isEncrypted(body.data)).toBe(true);
    // And the plaintext is genuinely not in the payload.
    expect(JSON.stringify(body)).not.toContain('Food');
  });

  // ── 2. Mixed states stay readable, which is what licenses the ordering ──

  it('reads a plaintext blob while a key is loaded', async () => {
    // Enable writes the config first, then encrypts budget by budget. Between
    // those, some blobs are plaintext and the key is loaded — that must work,
    // or a partial enable is a lockout rather than a resumable job.
    const key = await deriveKey('pass', randomBytes(16));
    api.setEncryptionRequired(true);
    api.setEncryptionKey(key);

    stubFetch(async () => ({
      status: 200,
      body: {
        version: 3,
        envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
        budgetItems: [],
        transactions: [],
        accounts: [{ id: 'a1', name: 'Main', initialBalance: 0 }],
        envelopeTemplates: [],
        meta: { schemaVersion: 8, name: 'Cloud' },
      },
    }));

    const out = await api.loadBudgetData({ kind: 'cloud', budgetId: 'b1', version: 0 });
    expect(out.envelopes[0].name).toBe('Food');
  });

  it('an encrypted blob with no key throws rather than returning ciphertext', async () => {
    // Disable writes the config last for the mirror-image reason: drop the
    // config while blobs are still encrypted and this is what sign-in hits.
    const key = await deriveKey('pass', randomBytes(16));
    api.setEncryptionKey(key);
    api.setEncryptionRequired(true);

    const calls = stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    await api.saveEnvelopes({ kind: 'cloud', budgetId: 'b1', version: 1 }, [{ id: 'e1', name: 'Food' }]);
    const ciphertext = putBody(calls, 'envelopes').data;

    api.setEncryptionKey(null);
    api.setEncryptionRequired(false);
    stubFetch(async () => ({
      status: 200,
      body: {
        version: 3,
        envelopes: ciphertext,
        budgetItems: [],
        transactions: [],
        accounts: [],
        envelopeTemplates: [],
        meta: { schemaVersion: 8 },
      },
    }));

    await expect(api.loadBudgetData({ kind: 'cloud', budgetId: 'b1', version: 0 }))
      .rejects.toThrow(/unlock|key/i);
  });

  it('round-trips through the key that encrypted it', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('pass', salt);
    api.setEncryptionKey(key);
    api.setEncryptionRequired(true);

    const calls = stubFetch(async () => ({ status: 200, body: { version: 2 } }));
    await api.saveEnvelopes({ kind: 'cloud', budgetId: 'b1', version: 1 },
      [{ id: 'e1', name: 'Food', category: 'Basics' }]);
    const ciphertext = putBody(calls, 'envelopes').data;

    // A freshly derived key from the same passphrase + salt must open it —
    // this is what makes a re-login able to read what the last session wrote.
    api.setEncryptionKey(await deriveKey('pass', salt));
    stubFetch(async () => ({
      status: 200,
      body: {
        version: 3,
        envelopes: ciphertext,
        budgetItems: [],
        transactions: [],
        accounts: [],
        envelopeTemplates: [],
        meta: { schemaVersion: 8 },
      },
    }));

    const out = await api.loadBudgetData({ kind: 'cloud', budgetId: 'b1', version: 0 });
    expect(out.envelopes[0].name).toBe('Food');
  });
});
