const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'bunvelope-smoke-'));
  // Keep budget data outside appData: Chromium protects that directory on
  // macOS/Windows, and the production restricted-directory denial must stay on.
  const dataRoot = await fs.mkdtemp(path.join(__dirname, '../.smoke-data-'));
  const args = [path.join(__dirname, 'smoke-entry.cjs')];
  if (process.env.BUNVELOPE_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const launch = () => electron.launch({
    executablePath: require('electron'), args,
    env: { ...process.env, BUNVELOPE_SMOKE_PROFILE: profile, XDG_CACHE_HOME: path.join(profile, 'cache') },
  });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    const errors = [];
    // Electron resolves beforeunload through will-prevent-unload, not CDP.
    page.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') dialog.dismiss(); });
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Welcome to Bunvelope' })).toBeVisible();
    const platform = await page.evaluate(() => ({
      secure: window.isSecureContext, picker: typeof window.showDirectoryPicker,
      node: typeof window.require,
    }));
    expect(platform).toEqual({ secure: true, picker: 'function', node: 'undefined' });
    expect(await page.evaluate(() => Object.keys(window.bunvelopeDesktop).sort())).toEqual(['getKey', 'price', 'setKey']);
    await application.evaluate(() => {
      globalThis.smokeOriginalFetch = globalThis.fetch;
      globalThis.fetch = async url => new Response(JSON.stringify(url.includes('/search')
        ? { quotes: [{ symbol: 'TEST' }] }
        : { chart: { result: [{ meta: { currency: 'EUR' }, timestamp: [1791244800], indicators: { quote: [{ close: [12.5] }] } }] } }));
    });
    const quote = await page.evaluate(async () => (await import('/js/state/investments.js')).fetchYahooQuote('TEST', { base: 'EUR' }));
    expect(quote.price).toBe(12.5);
    await application.evaluate(() => { globalThis.fetch = globalThis.smokeOriginalFetch; delete globalThis.smokeOriginalFetch; });
    const keyAvailable = await application.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()
      && safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
    const keyResult = await page.evaluate(() => {
      try { window.bunvelopeDesktop.setKey('smoke-test-key'); return window.bunvelopeDesktop.getKey(); }
      catch { return 'unavailable'; }
    });
    expect(keyResult).toBe(keyAvailable ? 'smoke-test-key' : 'unavailable');
    if (keyAvailable) {
      const keyFile = path.join(await application.evaluate(({ app }) => app.getPath('userData')), 'anthropic-key.enc');
      expect((await fs.readFile(keyFile)).includes(Buffer.from('smoke-test-key'))).toBe(false);
      await application.close();
      application = await launch();
      page = await application.firstWindow();
      page.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') dialog.dismiss(); });
      page.on('pageerror', error => errors.push(error.message));
      await expect(page.getByRole('heading', { name: 'Welcome to Bunvelope' })).toBeVisible();
      expect(await page.evaluate(() => window.bunvelopeDesktop.getKey())).toBe('smoke-test-key');
      await page.evaluate(() => window.bunvelopeDesktop.setKey(''));
      expect(await page.evaluate(() => window.bunvelopeDesktop.getKey())).toBe(null);
      await expect(fs.stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    console.log(keyAvailable ? 'OS key storage: encrypted file, restart, read and clear passed.'
      : 'OS key storage: unavailable backend correctly refused.');
    await page.evaluate(() => localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true })));
    await page.reload();
    await page.getByRole('button', { name: /Continue as guest/i }).click();
    await page.getByRole('button', { name: 'Load example budget' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // Native directory handle through Chromium's OS-file drag/drop path, with a
    // disposable folder. This avoids platform-specific automation of the picker.
    const budgetPath = path.join(dataRoot, 'smoke-budget');
    await fs.mkdir(budgetPath);
    await page.evaluate(() => {
      window.addEventListener('dragover', event => event.preventDefault());
      window.addEventListener('drop', event => {
        event.preventDefault();
        window.smokeFolder = event.dataTransfer.items[0].getAsFileSystemHandle();
      }, { once: true });
    });
    const cdp = await page.context().newCDPSession(page);
    // Let the newly navigated page reach the compositor before native hit tests.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const drag = { x: 400, y: 300, data: { items: [], files: [budgetPath], dragOperationsMask: 1 } };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
    await page.waitForFunction(() => !!window.smokeFolder);
    const permission = await application.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "window.smokeFolder.then(folder => folder.requestPermission({ mode: 'readwrite' })).catch(error => error.name + ': ' + error.message)", true);
    });
    expect(permission).toBe('granted');
    const saved = await page.evaluate(async () => {
      const storage = await import('/js/storage/fsapi-adapter.js');
      const folder = await window.smokeFolder;
      const filenames = ['envelopes.json', 'accounts.json', 'transactions.json',
        'budget-items.json', 'envelope-templates.json', 'budget-meta.json'];
      await storage.loadBudgetData(folder);
      const items = await Promise.all(filenames.map(async filename => ({
        filename, data: await (await fetch(`/budgets/example-project/${filename}`)).json(),
      })));
      await storage.writeBatch(folder, items);
      const bundle = await storage.loadBudgetData(folder);
      bundle.meta.name = 'Desktop persistence smoke';
      await storage.saveMeta(folder, bundle.meta);
      await storage.flushWrites();
      const { recordRecentBudget } = await import('/js/state/recent-budgets.js');
      await recordRecentBudget(folder);
      return (await storage.loadBudgetData(folder)).meta.name;
    });
    expect(saved).toBe('Desktop persistence smoke');
    expect(JSON.parse(await fs.readFile(path.join(budgetPath, 'budget-meta.json'), 'utf8')).name).toBe(saved);
    // Exercise pre-migration backup and restore with real disk handles.
    const metaPath = path.join(budgetPath, 'budget-meta.json');
    const legacyMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    legacyMeta.schemaVersion = 6;
    await fs.writeFile(metaPath, JSON.stringify(legacyMeta));
    const restoration = await page.evaluate(async () => {
      const storage = await import('/js/storage/index.js');
      const folder = await window.smokeFolder;
      await storage.loadBudgetData(folder);
      let backup;
      for await (const entry of folder.values()) if (entry.name.startsWith('backup-v6-')) backup = entry;
      if (!backup) throw new Error('Migration backup missing');
      const destination = await folder.getDirectoryHandle('restored-copy', { create: true });
      await storage.restoreMigrationBackup(backup, destination);
      const oldMeta = JSON.parse(await (await (await destination.getFileHandle('budget-meta.json')).getFile()).text());
      return oldMeta.schemaVersion;
    });
    expect(restoration).toBe(6);

    await fs.mkdir(path.join(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../artifacts/desktop.png') });
    await page.evaluate(async () => { (await import('/js/app.js')).navigate('settings'); });
    await page.getByRole('button', { name: 'Data & Security', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select migration backup…', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(__dirname, '../artifacts/migration-restore.png') });

    await page.reload();
    const persisted = await page.evaluate(async () => {
      const { listRecentBudgets } = await import('/js/state/recent-budgets.js');
      const storage = await import('/js/storage/fsapi-adapter.js');
      const recent = (await listRecentBudgets()).find(entry => entry.name === 'smoke-budget');
      return (await storage.loadBudgetData(recent.handle)).meta.name;
    });
    expect(persisted).toBe('Desktop persistence smoke');
    await page.evaluate(async () => {
      const { registerPending } = await import('/js/state/unload-guard.js');
      window.stopSmokePending = registerPending(() => true);
    });
    await application.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
      const window = BrowserWindow.getAllWindows()[0];
      const timer = setTimeout(() => reject(new Error('beforeunload did not block closing')), 5000);
      window.webContents.once('will-prevent-unload', () => { clearTimeout(timer); resolve(); });
      window.close();
    }));
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.evaluate(() => window.stopSmokePending());
    expect(errors).toEqual([]);
    console.log('Electron secure origin, sandbox and shared UI smoke passed.');
  } finally {
    await application.close();
    await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
