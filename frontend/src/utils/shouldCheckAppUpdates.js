import { isTauriDesktop } from "./desktopUpdater";

/** 是否应走 Cloudflare / Tauri updater 检查更新（Vite dev / 浏览器模式跳过）。 */
export async function shouldCheckAppUpdates() {
  if (import.meta.env?.DEV) return false;
  return isTauriDesktop();
}
