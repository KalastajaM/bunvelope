import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encryptJson,
  decryptJson,
  isEncrypted,
  buildVerifier,
  checkVerifier,
  randomBytes,
  bytesToBase64,
} from '../js/storage/crypto.js';

const SALT = randomBytes(16);

describe('crypto round-trip', () => {
  it('encrypts and decrypts an object', async () => {
    const key = await deriveKey('correct horse battery staple', SALT);
    const input = { envelopes: [{ id: 'a', name: 'Food', amount: 42 }] };
    const wrapper = await encryptJson(key, input);
    expect(isEncrypted(wrapper)).toBe(true);
    expect(wrapper.__enc).toBe(1);
    const out = await decryptJson(key, wrapper);
    expect(out).toEqual(input);
  });

  it('rejects a wrapper decrypted with the wrong key', async () => {
    const good = await deriveKey('right', SALT);
    const bad  = await deriveKey('wrong', SALT);
    const wrapper = await encryptJson(good, { x: 1 });
    await expect(decryptJson(bad, wrapper)).rejects.toThrow();
  });

  it('rejects tampered ciphertext (GCM auth tag)', async () => {
    const key = await deriveKey('pw', SALT);
    const wrapper = await encryptJson(key, { x: 1 });
    // Flip one base64 byte in the ciphertext.
    const bytes = atob(wrapper.ct).split('');
    bytes[0] = bytes[0] === 'A' ? 'B' : 'A';
    const tampered = { ...wrapper, ct: btoa(bytes.join('')) };
    await expect(decryptJson(key, tampered)).rejects.toThrow();
  });

  it('isEncrypted discriminates encrypted vs plaintext', () => {
    expect(isEncrypted({ __enc: 1, iv: 'x', ct: 'y' })).toBe(true);
    expect(isEncrypted({ envelopes: [] })).toBe(false);
    expect(isEncrypted([])).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted('hello')).toBe(false);
  });

  it('same passphrase + salt -> interoperable keys', async () => {
    const k1 = await deriveKey('pw', SALT);
    const k2 = await deriveKey('pw', SALT);
    const wrapper = await encryptJson(k1, { x: 1 });
    expect(await decryptJson(k2, wrapper)).toEqual({ x: 1 });
  });

  it('verifier round-trips and rejects wrong passphrase', async () => {
    const good = await deriveKey('right', SALT);
    const bad  = await deriveKey('wrong', SALT);
    const verifier = await buildVerifier(good);
    expect(await checkVerifier(good, verifier)).toBe(true);
    expect(await checkVerifier(bad, verifier)).toBe(false);
  });

  it('base64 salt input accepted by deriveKey', async () => {
    const b64 = bytesToBase64(SALT);
    const k1 = await deriveKey('pw', SALT);
    const k2 = await deriveKey('pw', b64);
    const wrapper = await encryptJson(k1, { x: 1 });
    expect(await decryptJson(k2, wrapper)).toEqual({ x: 1 });
  });
});
