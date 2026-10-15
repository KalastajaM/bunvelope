const fs = require('node:fs');
const path = require('node:path');
const { isAppPage } = require('./assets.cjs');

function createKeyStore(safeStorage, directory) {
  const file = path.join(directory, 'anthropic-key.enc');
  function available() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('OS key storage is unavailable');
    }
  }
  return {
    get() {
      available();
      try { return safeStorage.decryptString(fs.readFileSync(file)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    set(value) {
      available();
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid key');
      const key = value.trim();
      if (!key) { fs.rmSync(file, { force: true }); return; }
      const encrypted = safeStorage.encryptString(key);
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, encrypted, { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}

function trustedSender(event, window) {
  return !!window && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && isAppPage(event.senderFrame.url);
}

function installServices({ ipcMain, getWindow, keyStore, lookupPrice }) {
  ipcMain.on('bv:key', (event, action, value) => {
    // Always reply, including rejected callers; sendSync must not hang.
    try {
      if (!trustedSender(event, getWindow())) throw new Error('Untrusted sender');
      if (action === 'get') event.returnValue = { value: keyStore.get() };
      else if (action === 'set') { keyStore.set(value); event.returnValue = { value: null }; }
      else throw new Error('Invalid key operation');
    } catch { event.returnValue = { error: 'OS key storage unavailable or operation failed' }; }
  });
  let active = 0;
  let recent = [];
  ipcMain.handle('bv:price', async (event, kind, body) => {
    if (!trustedSender(event, getWindow())) throw new Error('Untrusted sender');
    if (!['url', 'quote'].includes(kind) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['url', 'query', 'base', 'debug'].includes(key)) ||
        typeof body[kind === 'url' ? 'url' : 'query'] !== 'string' ||
        body[kind === 'url' ? 'url' : 'query'].length > 2048 ||
        (body.base !== undefined && (typeof body.base !== 'string' || !/^[A-Z]{3}$/i.test(body.base))) ||
        (body.debug !== undefined && typeof body.debug !== 'boolean')) {
      return { status: 400, body: { error: 'invalid_price_request' } };
    }
    recent = recent.filter(at => Date.now() - at < 60_000);
    if (active >= 30 || recent.length >= 30) return { status: 429, body: { error: 'rate_limited' } };
    recent.push(Date.now()); active++;
    try { return await lookupPrice(kind, body); }
    finally { active--; }
  });
}
module.exports = { createKeyStore, trustedSender, installServices };
