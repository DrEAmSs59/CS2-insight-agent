import { useEffect, useState } from "react";
import {
  Copy,
  Minus,
  Square,
  X,
} from "lucide-react";
import { desktopBridge, isDesktopApp } from "../desktop/desktopBridge";
import { useT } from "../i18n/useT.js";

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export default function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const t = useT();

  const runWindowAction = (action) => {
    void action().catch((error) => {
      console.error("Desktop window action failed", error);
    });
  };

  useEffect(() => {
    if (!desktopBridge) return undefined;
    void desktopBridge.isMaximized().then(setIsMaximized);
    return desktopBridge.onMaximizeChange(setIsMaximized);
  }, []);

  return (
    <header
      className="app-topbar relative z-[90] flex w-full shrink-0 items-center border-b border-cs2-border-subtle bg-cs2-bg-page text-cs2-text-primary"
      data-tauri-drag-region
      data-testid="custom-titlebar"
    >
      <div className="flex h-full min-w-0 flex-1 items-center px-3" data-tauri-drag-region>
        <span
          className="select-none font-mono text-[9px] font-medium tracking-[0.08em] text-cs2-text-muted/65"
          data-tauri-drag-region
          data-testid="titlebar-version"
        >
          v{APP_VERSION}
        </span>
      </div>

      {isDesktopApp ? (
        <div className="flex h-full shrink-0 border-l border-cs2-border-subtle">
          <button
            type="button"
            aria-label={t("nav.minimize")}
            onClick={() => runWindowAction(() => desktopBridge.minimize())}
            className="flex h-full w-11 items-center justify-center text-cs2-text-muted transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={isMaximized ? t("nav.restore") : t("nav.maximize")}
            onClick={() => runWindowAction(() => desktopBridge.toggleMaximize())}
            className="flex h-full w-11 items-center justify-center text-cs2-text-muted transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
          >
            {isMaximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            aria-label={t("nav.close")}
            onClick={() => runWindowAction(() => desktopBridge.close())}
            className="flex h-full w-11 items-center justify-center text-cs2-text-muted transition-colors hover:bg-red-600 hover:text-white"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
