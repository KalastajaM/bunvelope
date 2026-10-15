const { contextBridge, ipcRenderer } = require('electron');
// Fixed capabilities only: no filesystem paths, arbitrary IPC or network URLs.
function key(action, value) {
  const result = ipcRenderer.sendSync('bv:key', action, value);
  if (result.error) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('bunvelopeDesktop', {
  getKey: () => key('get'),
  setKey: value => key('set', value),
  price: (kind, body) => ipcRenderer.invoke('bv:price', kind, body),
});
