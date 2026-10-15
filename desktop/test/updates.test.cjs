const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createUpdateCheck } = require('../main/updates.cjs');
const { strings } = require('../main/strings.cjs');

test('unconfigured developer builds never contact an update service', async () => {
  let shown;
  await createUpdateCheck({ app: { isPackaged: false }, text: strings('en'), getWindow: () => null,
    dialog: { showMessageBox: async (_window, options) => { shown = options.message; } },
  })();
  assert.match(shown, /not configured/);
});

test('download and install each require consent; installation uses the guarded close callback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app-update.yml'), 'test');
  const updater = new EventEmitter();
  let downloads = 0, installs = 0, closeAttempts = 0;
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } });
  updater.downloadUpdate = async () => { downloads++; };
  updater.quitAndInstall = () => { installs++; };
  let response = 0;
  const check = createUpdateCheck({ app: { isPackaged: true }, resourcesPath: root,
    updater, text: strings('en'), getWindow: () => null,
    dialog: { showMessageBox: async () => ({ response }) },
    install: async () => { closeAttempts++; }, // Simulate beforeunload refusing the close.
  });
  await check();
  assert.equal(downloads, 0);
  response = 1;
  await check();
  assert.equal(downloads, 1);
  assert.equal(closeAttempts, 1);
  assert.equal(installs, 0);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await check();
  assert.equal(downloads, 1); // Retrying install doesn't download again.
});
