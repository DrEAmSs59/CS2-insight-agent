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
  cancelUpdate: () => ipcRenderer.send('cancel-update'),
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  // 打开外部链接（使用系统默认浏览器）
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});