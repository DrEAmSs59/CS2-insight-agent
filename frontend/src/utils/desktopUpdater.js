import { desktopBridge, isDesktopApp } from "../desktop/desktopBridge.js";

/** Tauri 桌面壳注入 IPC 对象；浏览器 / Vite dev 页面无此对象。 */
export function isTauriDesktop() {
  return isDesktopApp;
}

/** @param {unknown} value */
export function normalizeUpdateMode(value) {
  return String(value || "").trim().toLowerCase() === "force" ? "force" : "normal";
}

/**
 * Tauri updater 检查/下载控制器。
 * 状态：checking / available / downloading / downloaded / not-available / error / cancelled
 *
 * 发现更新后会停在 available，等待 confirm() 再下载；defer()/cancel() 表示稍后再说。
 * force 模式下 defer/cancel 在开始下载前会被忽略。
 *
 * 注意：Tauri 的 downloadAndInstall 无法中断进行中的下载。
 */
export function createDesktopUpdateCheck(onStatus) {
  let cancelled = false;
  let updateMode = "normal";
  let confirmWait = null;
  let startedDownload = false;

  const emit = (payload) => {
    try {
      onStatus?.(payload);
    } catch {
      // 状态回调异常不应中断更新流程
    }
  };

  const waitForUserChoice = () =>
    new Promise((resolve) => {
      confirmWait = resolve;
    });

  const resolveChoice = (choice) => {
    if (!confirmWait) return false;
    if (updateMode === "force" && choice !== "install" && !startedDownload) {
      return false;
    }
    const wait = confirmWait;
    confirmWait = null;
    wait(choice);
    return true;
  };

  const run = async () => {
    emit({ status: "checking", update_mode: "normal" });

    let update = null;
    try {
      update = await desktopBridge?.checkForUpdate();
    } catch (error) {
      emit({ status: "error", error: String(error?.message || error), update_mode: "normal" });
      return;
    }
    if (cancelled) {
      emit({ status: "cancelled", update_mode: "normal" });
      return;
    }
    if (!update) {
      emit({ status: "not-available", update_mode: "normal" });
      return;
    }

    updateMode = normalizeUpdateMode(update.rawJson?.update_mode);
    const latest = update.version || null;
    const notes = typeof update.body === "string" ? update.body : "";
    const base = {
      latest_version: latest,
      release_notes: notes,
      update_mode: updateMode,
    };
    emit({ status: "available", ...base });

    const choice = await waitForUserChoice();
    if (cancelled || choice !== "install") {
      try {
        await update.close();
      } catch {
        // ignore
      }
      emit({ status: "cancelled", ...base });
      return;
    }

    startedDownload = true;
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
    try {
      await desktopBridge?.relaunch();
    } catch {
      // 安装器已接管进程时 relaunch 可能失败，忽略
    }
  };

  return {
    start: () => {
      void run();
    },
    /** 用户确认立即更新 */
    confirm: () => {
      resolveChoice("install");
    },
    /** 稍后再说（force 且尚未开始下载时无效） */
    defer: () => {
      cancelled = true;
      resolveChoice("defer");
    },
    cancel: () => {
      cancelled = true;
      resolveChoice("defer");
    },
  };
}
