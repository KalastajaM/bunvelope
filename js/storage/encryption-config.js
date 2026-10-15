// A passphrase protects the data key, not each budget. Legacy accounts used the
// derived key directly; their first rotation wraps that same key. Budget blobs
// and versions never change, so either outcome of an uncertain config commit
// can still decrypt every budget after a reload.
import {
  deriveKey, randomBytes, bytesToBase64, base64ToBytes,
  checkVerifier, buildVerifier, encryptJson, decryptJson,
} from './crypto.js';

export async function unlockDataKey(config, passphrase) {
  const wrappingKey = await deriveKey(passphrase, base64ToBytes(config.salt), true);
  if (!(await checkVerifier(wrappingKey, config.verifier))) return null;
  if (!Object.hasOwn(config.verifier, 'wrappedKey')) return wrappingKey;
  const raw = base64ToBytes(await decryptJson(wrappingKey, config.verifier.wrappedKey));
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function preparePassphraseChange(config, oldPassphrase, newPassphrase) {
  const dataKey = await unlockDataKey(config, oldPassphrase);
  if (!dataKey) throw new Error('Incorrect current passphrase');
  const salt = randomBytes(16);
  const wrappingKey = await deriveKey(newPassphrase, salt);
  const raw = await globalThis.crypto.subtle.exportKey('raw', dataKey);
  const verifier = await buildVerifier(wrappingKey);
  verifier.keyId = config.verifier.keyId || config.salt;
  verifier.wrappedKey = await encryptJson(wrappingKey, bytesToBase64(new Uint8Array(raw)));
  return { enabled: true, salt: bytesToBase64(salt), verifier };
}

// Enable/disable changes blobs, but never changes the active key while requests
// are in flight. In particular a failed disable must not reopen plaintext saves.
export async function convertBudgetEncryption(api, destinationKey, onProgress = () => {}) {
  await api.flushWrites();
  const budgets = await api.listCloudBudgets();
  for (const [index, budget] of budgets.entries()) {
    onProgress(index, budgets.length, budget.name);
    const ref = { kind: 'cloud', budgetId: budget.id, version: 0 };
    // An unfinished budget (setup wizard never completed) has no meta, and
    // loadBudgetData invents one for it. Writing that back would mark the
    // budget as set up and skip the wizard, so leave it untouched: the wizard
    // has written nothing under any key yet. Same fetch as below (ref cache).
    if (await api.readJson(ref, 'budget-meta.json') == null) continue;
    const bundle = await api.loadBudgetData(ref);
    await api.writeBatch(ref, [
      { filename: 'envelopes.json', data: bundle.envelopes },
      { filename: 'budget-items.json', data: bundle.budgetItems },
      { filename: 'transactions.json', data: bundle.transactions },
      { filename: 'accounts.json', data: bundle.accounts },
      { filename: 'envelope-templates.json', data: bundle.envelopeTemplates },
      { filename: 'budget-meta.json', data: bundle.meta },
    ], { key: destinationKey, required: !!destinationKey });
  }
}
