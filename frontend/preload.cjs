const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  unmaximize: () => ipcRenderer.send('window-unmaximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  isPackaged: () => ipcRenderer.invoke('is-packaged'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onMaximizeChange: (callback) => ipcRenderer.on('window-maximize-change', (_event, isMaximized) => callback(isMaximized)),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status)),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options)
});