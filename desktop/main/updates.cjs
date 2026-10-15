const fs = require('node:fs');
const path = require('node:path');

// No background download or install-on-quit. All updates require a user action.
function createUpdateCheck({ app, dialog, getWindow, install, text, resourcesPath = process.resourcesPath, updater }) {
  let busy = false;
  let downloaded = false;
  const message = (body, detail = '') => dialog.showMessageBox(getWindow(), {
    type: 'info', title: text.title, message: body, detail,
  });
  return async () => {
    if (busy) return;
    busy = true;
    try {
      if (!app.isPackaged || !fs.existsSync(path.join(resourcesPath, 'app-update.yml'))) {
        await message(text.updateUnavailable);
        return;
      }
      if (!updater) updater = require('electron-updater').autoUpdater;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      // electron-updater emits errors as well as rejecting its public promises.
      if (updater.listenerCount('error') === 0) updater.on('error', () => {});
      if (!downloaded) {
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable) { await message(text.upToDate); return; }
        const { response } = await dialog.showMessageBox(getWindow(), {
          title: text.title, message: `${text.updateFound} ${result.updateInfo.version}`,
          buttons: [text.cancel, text.download], defaultId: 0, cancelId: 0,
        });
        if (response !== 1) return;
        await updater.downloadUpdate();
        downloaded = true;
      }
      const { response } = await dialog.showMessageBox(getWindow(), {
        title: text.title, message: text.updateReady,
        buttons: [text.later, text.install], defaultId: 0, cancelId: 0,
      });
      if (response === 1) await install(() => updater.quitAndInstall(false, true));
    } catch (error) {
      await message(text.updateError, error.message);
    } finally { busy = false; }
  };
}
module.exports = { createUpdateCheck };
