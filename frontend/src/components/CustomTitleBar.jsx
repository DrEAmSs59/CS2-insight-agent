import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  Clapperboard,
  Copy,
  FileText,
  Library,
  Minus,
  Moon,
  Package,
  Settings,
  Square,
  Sun,
  X,
} from "lucide-react";
import API from "../api/api";
import { desktopBridge, isDesktopApp } from "../desktop/desktopBridge";
import { useT } from "../i18n/useT.js";
import { useReplayStore } from "../stores/replayStore";
import { useThemeStore } from "../stores/themeStore";

const NAV_ITEMS = [
  { to: "/", end: true, labelKey: "nav.guide", icon: BookOpen },
  { to: "/library", labelKey: "nav.demoLibrary", icon: Library },
  { to: "/analysis", labelKey: "nav.analysis", icon: BarChart3 },
  { to: "/queue", labelKey: "nav.recordQueue", icon: Package, queue: true, guarded: true },
  { to: "/montage", labelKey: "nav.montage", icon: Clapperboard, guarded: true },
  { to: "/lite-cut", label: "LiteCut", icon: Clapperboard, guarded: true },
];

function suspendReplayPlayback() {
  useReplayStore.getState().requestSuspendPlayback();
}

export default function CustomTitleBar({ queueLength = 0, disabled = false }) {
  const [isMaximized, setIsMaximized] = useState(false);
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
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
      className="app-topbar relative z-[90] flex w-full shrink-0 items-center border-b border-white/8 bg-[#141311] text-zinc-100"
      data-tauri-drag-region
      data-testid="custom-titlebar"
    >
      <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3" data-tauri-drag-region>
        <div className="flex shrink-0 items-center gap-2 pr-2" data-tauri-drag-region>
          <img
            src={`${import.meta.env.BASE_URL}cs2-insight-logo.png`}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-md"
            data-tauri-drag-region
          />
          <span className="max-w-44 truncate text-[13px] font-bold tracking-tight max-[1180px]:hidden" data-tauri-drag-region>
            {t("nav.brand")}
          </span>
        </div>

        <nav
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label={t("nav.mainNav")}
          onPointerDownCapture={suspendReplayPlayback}
        >
          {NAV_ITEMS.map(({ to, end, labelKey, label, icon: Icon, queue, guarded }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-disabled={guarded && disabled ? true : undefined}
              className={({ isActive }) => [
                "group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold transition-colors",
                isActive
                  ? "bg-white/12 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  : "text-zinc-400 hover:bg-white/7 hover:text-zinc-100",
                guarded && disabled ? "pointer-events-none opacity-40" : "",
              ].join(" ")}
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 ${to === "/lite-cut" ? "text-amber-400" : ""}`} />
              <span className="max-[1080px]:hidden">{labelKey ? t(labelKey) : label}</span>
              {queue ? (
                <span className="min-w-4 rounded bg-cs2-accent px-1 text-center font-mono text-[9px] font-black leading-4 text-black">
                  {queueLength}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="min-w-4 flex-1" data-tauri-drag-region />

        <NavLink
          to="/settings"
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
          className={({ isActive }) => `flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${isActive ? "bg-white/12 text-white" : "text-zinc-400 hover:bg-white/7 hover:text-white"}`}
        >
          <Settings className="h-3.5 w-3.5" />
        </NavLink>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
          title={theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/7 hover:text-white"
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label={t("nav.openLogs")}
          title={t("nav.openLogs")}
          onClick={() => runWindowAction(() => API.post("config/open-logs"))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/7 hover:text-white"
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
      </div>

      {isDesktopApp ? (
        <div className="flex h-full shrink-0 border-l border-white/6">
          <button
            type="button"
            aria-label={t("nav.minimize")}
            onClick={() => runWindowAction(() => desktopBridge.minimize())}
            className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={isMaximized ? t("nav.restore") : t("nav.maximize")}
            onClick={() => runWindowAction(() => desktopBridge.toggleMaximize())}
            className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            {isMaximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            aria-label={t("nav.close")}
            onClick={() => runWindowAction(() => desktopBridge.close())}
            className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-red-600 hover:text-white"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
