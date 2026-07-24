import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Tauri 桌面壳注入 IPC 对象；浏览器 / Vite dev 页面无此对象。 */
export function isTauriDesktop() {
  return Boolean(window.__TAURI_INTERNALS__);
}

/**
 * Tauri updater 检查/下载控制器。状态语义对齐旧 electron-updater 通道，
 * UpdateCheckModal 无需改动：
 * checking / available / downloading / downloaded / not-available / error / cancelled
 *
 * 注意：Tauri 的 downloadAndInstall 无法中断进行中的下载，cancel() 只在
 * 尚未开始下载安装前生效（checking / available 阶段）。
 */
export function createDesktopUpdateCheck(onStatus) {
  let cancelled = false;

  const emit = (payload) => {
    try {
      onStatus?.(payload);
    } catch {
      // 状态回调异常不应中断更新流程
    }
  };

  const run = async () => {
    emit({ status: "checking" });

    let update = null;
    try {
      update = await check();
    } catch (error) {
      emit({ status: "error", error: String(error?.message || error) });
      return;
    }
    if (cancelled) {
      emit({ status: "cancelled" });
      return;
    }
    if (!update) {
      emit({ status: "not-available" });
      return;
    }

    const latest = update.version || null;
    const notes = typeof update.body === "string" ? update.body : "";
    const base = { latest_version: latest, release_notes: notes };
    emit({ status: "available", ...base });
    if (cancelled) {
      emit({ status: "cancelled", ...base });
      return;
    }

    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = Number(event.data?.contentLength) || 0;
          emit({ status: "downloading", ...base, progress: { percent: 0 } });
        } else if (event.event === "Progress") {
          received += Number(event.data?.chunkLength) || 0;
          emit({
            status: "downloading",
            ...base,
            progress: { percent: total > 0 ? (received / total) * 100 : NaN },
          });
        } else if (event.event === "Finished") {
          emit({ status: "downloaded", ...base });
        }
      });
    } catch (error) {
      emit({ status: "error", ...base, error: String(error?.message || error) });
      return;
    }

    emit({ status: "downloaded", ...base });
    // Windows 上 NSIS 安装器启动时应用会被自动退出、装完后由安装器重启，
    // 通常执行不到这里；其他平台需要显式重启。
    try {
      await relaunch();
    } catch {
      // 安装器已接管进程时 relaunch 可能失败，忽略
    }
  };

  return {
    start: () => {
      void run();
    },
    cancel: () => {
      cancelled = true;
    },
  };
}
