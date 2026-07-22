import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { desktopBridge, isDesktopApp } from "../desktop/desktopBridge";

export default function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

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

  if (!isDesktopApp) return null;

  return (
    <div
      className="flex w-full shrink-0 items-center justify-between bg-[#111111] text-white z-50"
      style={{ height: "50px" }}
      data-tauri-drag-region
      onMouseDown={(event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        if (event.detail === 2) {
          runWindowAction(() => desktopBridge.toggleMaximize());
          return;
        }
        runWindowAction(() => desktopBridge.startDragging());
      }}
    >
      <div className="flex items-center px-4" data-tauri-drag-region>
        <img
          src={`${import.meta.env.BASE_URL}cs2-insight-logo.png`}
          alt="Logo"
          className="mr-2 h-6 w-6"
          data-tauri-drag-region
        />
        <span className="text-sm font-semibold" data-tauri-drag-region>CS2 Insight Agent</span>
      </div>

      <div className="flex h-full">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => runWindowAction(() => desktopBridge.minimize())}
          className="flex h-full w-12 items-center justify-center transition-colors hover:bg-white/10"
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          aria-label="Toggle maximize"
          onClick={() => runWindowAction(() => desktopBridge.toggleMaximize())}
          className="flex h-full w-12 items-center justify-center transition-colors hover:bg-white/10"
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => runWindowAction(() => desktopBridge.close())}
          className="flex h-full w-12 items-center justify-center transition-colors hover:bg-red-600"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
