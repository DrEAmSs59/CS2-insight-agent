/** 是否应走 Cloudflare / electron-updater 检查更新（Vite dev / 未打包 / 非 Electron 均跳过）。 */
export async function shouldCheckAppUpdates() {
  if (import.meta.env?.DEV) return false;
  if (!window.electron?.checkForUpdates) return false;
  if (window.electron?.isPackaged) {
    return Boolean(await window.electron.isPackaged());
  }
  return false;
}
