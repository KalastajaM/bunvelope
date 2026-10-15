const { isAppPage } = require('./assets.cjs');

function installPermissions(session, getWindow) {
  const trusted = contents => contents && contents === getWindow()?.webContents
    && isAppPage(contents.getURL());
  session.setPermissionCheckHandler((contents, permission, origin) => {
    // Electron supplies null WebContents for filesystem checks and treats false
    // as DENIED, not ASK. Chromium owns the directory handles: the renderer can
    // obtain them only from a user-activated picker/drop or persisted handles,
    // never by inventing a filesystem path. Allow this origin to use those
    // capabilities; do not grant unrelated origins or browser permissions.
    return permission === 'fileSystem' && isAppPage(origin)
      && (!contents || trusted(contents));
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'fileSystem' && trusted(contents) && isAppPage(details.requestingUrl));
  });
  // Preserve Chromium's protection of OS and other sensitive directories.
  session.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'));
}
module.exports = { installPermissions };
