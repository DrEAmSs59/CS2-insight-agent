/** 是否应请求版本更新（Vite dev / Electron 未打包客户端均跳过）。 */
export async function shouldCheckAppUpdates() {
  if (import.meta.env?.DEV) return false;
  if (window.electron?.isPackaged) {
    return Boolean(await window.electron.isPackaged());
  }
  return true;
}
