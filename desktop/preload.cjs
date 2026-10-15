const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'reviewStudio',
  Object.freeze({
    onNavigate: (callback) => {
      const listener = (_event, page) => callback(page);
      ipcRenderer.on('navigate', listener);
      return () => ipcRenderer.removeListener('navigate', listener);
    },
    getPreferences: () => ipcRenderer.invoke('preferences:get'),
    setPreferences: (values) => ipcRenderer.invoke('preferences:set', values),
    setApiKey: (key) => ipcRenderer.invoke('credentials:set', key),
    selectDirectory: () => ipcRenderer.invoke('directory:select'),
  }),
);
