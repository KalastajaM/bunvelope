const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKeyStore, installServices } = require('../main/services.cjs');

test('encrypted persistence, replace, clear and refusal of insecure backend', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-key-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const safe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s.split('').reverse().join('')),
    decryptString: b => b.toString().split('').reverse().join(''), getSelectedStorageBackend: () => 'keychain' };
  const store = createKeyStore(safe, directory);
  assert.equal(store.get(), null);
  store.set('fake-test-key');
  assert.ok(!fs.readFileSync(path.join(directory, 'anthropic-key.enc')).includes('fake-test-key'));
  assert.equal(createKeyStore(safe, directory).get(), 'fake-test-key');
  safe.encryptString = () => { throw new Error('locked'); };
  assert.throws(() => store.set('replacement'));
  assert.equal(store.get(), 'fake-test-key');
  store.set(''); assert.equal(store.get(), null);
  safe.getSelectedStorageBackend = () => 'basic_text';
  assert.throws(() => store.set('secret'), /unavailable/);
  assert.throws(() => store.get(), /unavailable/);
});

test('IPC rejects foreign frames and invalid requests, routes valid requests, caps traffic', async () => {
  const handlers = {};
  const ipcMain = { on: (n, f) => { handlers[n] = f; }, handle: (n, f) => { handlers[n] = f; } };
  const frame = { url: 'bunvelope://app/index.html' };
  const window = { webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  installServices({ ipcMain, getWindow: () => window, keyStore: { get: () => 'test' },
    lookupPrice: async (kind, body) => ({ status: 200, body: { kind, query: body.query } }) });
  const foreign = { sender: {}, senderFrame: frame };
  handlers['bv:key'](foreign, 'get'); assert.ok(foreign.returnValue.error);
  await assert.rejects(handlers['bv:price'](foreign, 'quote', { query: 'AAPL' }));
  handlers['bv:key'](event, 'get'); assert.equal(event.returnValue.value, 'test');
  assert.equal((await handlers['bv:price'](event, 'quote', { query: 'AAPL', extra: true })).status, 400);
  assert.equal((await handlers['bv:price'](event, 'quote', { query: 'AAPL', base: 'EUR' })).body.query, 'AAPL');
  for (let i = 0; i < 29; i++) await handlers['bv:price'](event, 'quote', { query: 'AAPL' });
  assert.equal((await handlers['bv:price'](event, 'quote', { query: 'AAPL' })).status, 429);
});
