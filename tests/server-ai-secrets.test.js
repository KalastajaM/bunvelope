// tests/server-ai-secrets.test.js — round-trip and failure modes for
// server/ai/secrets.js. The master key cache is module-scoped, so each
// scenario uses _resetSecretsCacheForTests + adjusts process.env before
// the call so the lazy load picks up the new value.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptApiKey, decryptApiKey, secretsAlg, previewApiKey,
  _resetSecretsCacheForTests,
} from '../server/ai/secrets.js';

const TEST_MASTER = randomBytes(32).toString('base64');

beforeEach(() => {
  _resetSecretsCacheForTests();
  delete process.env.BUNVELOPE_SECRETS_KEY;
});

describe('secrets — encryption round-trip', () => {
  it('round-trips through AES-256-GCM when a master key is configured', () => {
    process.env.BUNVELOPE_SECRETS_KEY = TEST_MASTER;
    _resetSecretsCacheForTests();
    expect(secretsAlg()).toBe('aes-256-gcm');

    const plain = 'sk-ant-abcdef1234567890';
    const enc = encryptApiKey(plain);
    expect(enc.alg).toBe('aes-256-gcm');
    expect(enc.iv).toHaveLength(12);
    expect(enc.tag).toHaveLength(16);
    expect(enc.ct).not.toEqual(Buffer.from(plain, 'utf8'));

    expect(decryptApiKey(enc)).toBe(plain);
  });

  it('falls back to plaintext records when no master key is set', () => {
    _resetSecretsCacheForTests();
    expect(secretsAlg()).toBe('none');

    const plain = 'sk-ant-plaintext-fallback';
    const enc = encryptApiKey(plain);
    expect(enc.alg).toBe('plaintext');
    expect(enc.iv).toBeNull();
    expect(enc.tag).toBeNull();
    expect(enc.ct.toString('utf8')).toBe(plain);

    expect(decryptApiKey(enc)).toBe(plain);
  });

  it('uses unique IVs across encryptions of the same value', () => {
    process.env.BUNVELOPE_SECRETS_KEY = TEST_MASTER;
    _resetSecretsCacheForTests();
    const a = encryptApiKey('sk-ant-same-value');
    const b = encryptApiKey('sk-ant-same-value');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ct.equals(b.ct)).toBe(false);
  });
});

describe('secrets — failure modes', () => {
  it('rejects a master key that decodes to the wrong length', () => {
    process.env.BUNVELOPE_SECRETS_KEY = Buffer.alloc(16, 0).toString('base64');
    _resetSecretsCacheForTests();
    expect(() => encryptApiKey('sk-ant-x')).toThrow(/32 bytes/);
  });

  it('keeps refusing a configured invalid key after an earlier failure', () => {
    process.env.BUNVELOPE_SECRETS_KEY = 'invalid';
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => secretsAlg()).toThrow(/32 bytes/);
      expect(() => encryptApiKey('must-never-be-plaintext')).toThrow(/32 bytes/);
    }
  });

  it('refuses empty plaintext', () => {
    process.env.BUNVELOPE_SECRETS_KEY = TEST_MASTER;
    _resetSecretsCacheForTests();
    expect(() => encryptApiKey('')).toThrow(/non-empty/);
  });

  it('rejects an aes-256-gcm record when the master key is gone', () => {
    process.env.BUNVELOPE_SECRETS_KEY = TEST_MASTER;
    _resetSecretsCacheForTests();
    const enc = encryptApiKey('sk-ant-rotated');

    delete process.env.BUNVELOPE_SECRETS_KEY;
    _resetSecretsCacheForTests();
    expect(() => decryptApiKey(enc)).toThrow(/BUNVELOPE_SECRETS_KEY/);
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    process.env.BUNVELOPE_SECRETS_KEY = TEST_MASTER;
    _resetSecretsCacheForTests();
    const enc = encryptApiKey('sk-ant-tamper-me');
    // Flip every bit of the first byte. Zeroing it instead left the ciphertext
    // unchanged whenever that byte was already 0, one run in 256.
    const ct = Buffer.from(enc.ct);
    ct[0] ^= 0xff;
    const tampered = { ...enc, ct };
    expect(() => decryptApiKey(tampered)).toThrow();
  });

  it('rejects unknown algs', () => {
    expect(() => decryptApiKey({ alg: 'rot13', ct: Buffer.from('x') }))
      .toThrow(/unknown alg/);
  });
});

describe('previewApiKey', () => {
  it('returns the last 4 characters', () => {
    expect(previewApiKey('sk-ant-something-AB12')).toBe('AB12');
  });
  it('handles short / empty / non-string input safely', () => {
    expect(previewApiKey('xy')).toBe('xy');
    expect(previewApiKey('')).toBe('');
    expect(previewApiKey(null)).toBe('');
    expect(previewApiKey(undefined)).toBe('');
  });
});
