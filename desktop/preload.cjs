const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'reviewStudio',
  Object.freeze({
    onNavigate: (callback) => {
      const listener = (_event, page) => callback(page);
      let active = true;
      ipcRenderer.on('navigate', listener);
      void ipcRenderer
        .invoke('navigation:ready')
        .then((page) => {
          if (active && page) callback(page);
        })
        .catch(() => {});
      return () => {
        active = false;
        ipcRenderer.removeListener('navigate', listener);
      };
    },
    testNotification: () => ipcRenderer.invoke('notifications:test'),
    openNotificationSettings: () => ipcRenderer.invoke('notifications:settings'),
    restart: () => ipcRenderer.invoke('app:restart'),
    getPreferences: () => ipcRenderer.invoke('preferences:get'),
    setPreferences: (values) => ipcRenderer.invoke('preferences:set', values),
    setApiKey: (key) => ipcRenderer.invoke('credentials:set', key),
    selectDirectory: () => ipcRenderer.invoke('directory:select'),
  }),
);
