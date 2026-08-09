import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export const isDesktopApp = Boolean(window.__TAURI_INTERNALS__);

const currentWindow = isDesktopApp ? getCurrentWindow() : null;

export const desktopBridge = isDesktopApp
  ? {
      minimize: () => currentWindow.minimize(),
      toggleMaximize: () => currentWindow.toggleMaximize(),
      close: () => currentWindow.close(),
      startDragging: () => currentWindow.startDragging(),
      isMaximized: () => currentWindow.isMaximized(),
      onMaximizeChange(callback) {
        let active = true;
        const unlistenPromise = currentWindow.onResized(async () => {
          if (active) callback(await currentWindow.isMaximized());
        });
        return () => {
          active = false;
          void unlistenPromise.then((unlisten) => unlisten());
        };
      },
      getVersion,
      checkForUpdate: () => check(),
      relaunch: () => relaunch(),
      readLegacyUiState: () => invoke("read_legacy_ui_state"),
      writeClipboardText: (text) => writeText(String(text ?? "")),
      async showOpenDialog(options = {}) {
        const properties = Array.isArray(options.properties) ? options.properties : [];
        const selected = await open({
          title: options.title,
          defaultPath: options.defaultPath,
          filters: options.filters,
          directory: properties.includes("openDirectory"),
          multiple: properties.includes("multiSelections"),
        });
        const filePaths = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
        return { canceled: filePaths.length === 0, filePaths };
      },
      async chooseDemoFiles() {
        try {
          const selected = await open({
            title: "选择 CS2 Demo",
            filters: [{ name: "CS2 Demo", extensions: ["dem"] }],
            multiple: true,
          });
          return selected == null ? [] : Array.isArray(selected) ? selected : [selected];
        } catch {
          return [];
        }
      },
      async chooseDirectory(defaultPath = "", title = "选择文件夹") {
        try {
          const selected = await open({
            title,
            defaultPath: typeof defaultPath === "string" && defaultPath.trim() ? defaultPath.trim() : undefined,
            directory: true,
            multiple: false,
          });
          return typeof selected === "string" ? selected : "";
        } catch {
          return "";
        }
      },
      async showItemInFolder(itemPath) {
        if (typeof itemPath !== "string" || !itemPath.trim()) return false;
        try {
          await revealItemInDir(itemPath.trim());
          return true;
        } catch {
          return false;
        }
      },
      openExternal: (url) => openUrl(url),
    }
  : null;
