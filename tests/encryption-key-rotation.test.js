import { describe, expect, it } from 'vitest';
import * as config from '../js/storage/encryption-config.js';
import { deriveKey, randomBytes, bytesToBase64, buildVerifier, encryptJson, decryptJson } from '../js/storage/crypto.js';

async function legacy() {
  const salt = randomBytes(16);
  const key = await deriveKey('old passphrase', salt);
  return { key, cfg: { enabled: true, salt: bytesToBase64(salt), verifier: await buildVerifier(key) } };
}
describe('passphrase changes preserve the budget data key', () => {
  it('keeps existing ciphertext readable after repeated changes and reloads', async () => {
    const { key, cfg } = await legacy();
    const ciphertext = await encryptJson(key, { transactions: [{ id: 't', amount: 12 }] });
    const next = await config.preparePassphraseChange(cfg, 'old passphrase', 'new passphrase');
    const reopened = await config.unlockDataKey(next, 'new passphrase');
    expect(await decryptJson(reopened, ciphertext)).toEqual({ transactions: [{ id: 't', amount: 12 }] });
    expect(await config.unlockDataKey(next, 'old passphrase')).toBe(null);
    const third = await config.preparePassphraseChange(next, 'new passphrase', 'third passphrase');
    expect(await decryptJson(await config.unlockDataKey(third, 'third passphrase'), ciphertext)).toEqual(await decryptJson(key, ciphertext));
  });
  it('leaves both possible commit outcomes recoverable after a lost response', async () => {
    const { key, cfg } = await legacy();
    const ciphertext = await encryptJson(key, ['unchanged budget']);
    const next = await config.preparePassphraseChange(cfg, 'old passphrase', 'new passphrase');
    for (const [persisted, pass] of [[cfg, 'old passphrase'], [next, 'new passphrase']]) {
      expect(await decryptJson(await config.unlockDataKey(persisted, pass), ciphertext)).toEqual(['unchanged budget']);
    }
  });
  it('rejects an incorrect old passphrase without creating a config', async () => {
    const { cfg } = await legacy();
    await expect(config.preparePassphraseChange(cfg, 'wrong', 'new passphrase')).rejects.toThrow(/passphrase/i);
  });
  it('fails closed if a wrapped data key is tampered with', async () => {
    const { cfg } = await legacy();
    const next = await config.preparePassphraseChange(cfg, 'old passphrase', 'new passphrase');
    next.verifier.wrappedKey.ct = 'AAAA';
    await expect(config.unlockDataKey(next, 'new passphrase')).rejects.toThrow();
  });
});
