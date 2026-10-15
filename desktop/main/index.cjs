const { app, BrowserWindow, Menu, protocol, session, dialog, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createKeyStore, installServices } = require('./services.cjs');
const { ENTRY, isAppPage, serveAsset } = require('./assets.cjs');
const { installPermissions } = require('./permissions.cjs');
const { strings } = require('./strings.cjs');
const { createUpdateCheck } = require('./updates.cjs');

// Stable secure origin preserves IndexedDB folder handles and preferences across
// application upgrades. Never use a random localhost port or file:// origin.
protocol.registerSchemesAsPrivileged([{ scheme: 'bunvelope', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

// Separate from both the browser profile and the installed application directory.
app.setPath('userData', path.join(app.getPath('appData'), 'Bunvelope'));
let window;
let createWindow;
let installing = false;
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) { createWindow?.(); return; }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.whenReady().then(async () => {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.resolve(__dirname, '../..');
    protocol.handle('bunvelope', request => serveAsset(request, root));
    const servicePath = app.isPackaged
      ? path.join(process.resourcesPath, 'services/price-service.mjs')
      : path.resolve(__dirname, '../../server/price-service.js');
    const { lookupPrice } = await import(pathToFileURL(servicePath).href);
    installServices({ ipcMain, getWindow: () => window,
      keyStore: createKeyStore(safeStorage, app.getPath('userData')), lookupPrice });
    // Folder access remains user-selected through Chromium's native picker.
    // The preload exposes only key storage and bounded price lookups.
    const text = strings(app.getLocale());
    installPermissions(session.defaultSession, () => window);
    const checkUpdates = createUpdateCheck({
      app, dialog, getWindow: () => window, text,
      install: async finish => {
        if (!window) { finish(); return; }
        const contents = window.webContents;
        const closed = () => { contents.removeListener('will-prevent-unload', blocked); finish(); };
        const blocked = () => {
          installing = false;
          window.removeListener('closed', closed);
          dialog.showMessageBox(window, { message: text.pending });
        };
        installing = true;
        contents.once('will-prevent-unload', blocked);
        window.once('closed', closed);
        window.close();
      },
    });
    createWindow = () => {
      window = new BrowserWindow({
        width: 1280, height: 900, minWidth: 800, minHeight: 600,
        title: 'Bunvelope', show: false,
        webPreferences: {
          nodeIntegration: false, contextIsolation: true, sandbox: true,
          webSecurity: true, spellcheck: false, preload: path.join(__dirname, 'preload.cjs'),
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (!isAppPage(url)) event.preventDefault(); });
      // Electron otherwise gives applications the option to ignore beforeunload.
      // Keep the app's existing guard authoritative: pending saves cancel close,
      // reload and quit, including the quit preceding an update.
      window.webContents.on('will-prevent-unload', () => {});
      window.once('ready-to-show', () => window.show());
      window.on('closed', () => { window = null; });
      window.loadURL(ENTRY);
    };
    const template = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' }, { role: 'editMenu' },
      { label: text.view, submenu: [
        { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' },
        { role: 'zoomOut' }, { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
      ] },
      { role: 'windowMenu' },
      { label: text.help, submenu: [{ label: text.update, click: checkUpdates }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox(strings(app.getLocale()).startError, error.message);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !installing) app.quit(); });
}
