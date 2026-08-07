import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  Clapperboard,
  FileText,
  Library,
  Moon,
  Package,
  PanelLeft,
  Settings,
  Sun,
} from "lucide-react";
import API from "../api/api";
import { useT } from "../i18n/useT.js";
import { useReplayStore } from "../stores/replayStore";
import { useThemeStore } from "../stores/themeStore";

const STORAGE_KEY = "cs2-insight:sidebar-layout-v2";
const DEFAULT_WIDTH = 224;
const MIN_WIDTH = 184;
const MAX_WIDTH = 340;
const COLLAPSED_WIDTH = 56;
const SIDEBAR_Z_INDEX = 40;

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const NAV_ITEMS = [
  { to: "/", end: true, labelKey: "nav.guide", icon: BookOpen },
  { to: "/library", labelKey: "nav.demoLibrary", icon: Library },
  { to: "/analysis", labelKey: "nav.analysis", icon: BarChart3 },
  { to: "/queue", labelKey: "nav.recordQueue", icon: Package, queue: true, guarded: true },
  { to: "/montage", labelKey: "nav.montage", icon: Clapperboard, guarded: true },
  { to: "/lite-cut", label: "LiteCut", icon: Clapperboard, guarded: true },
];

function clampWidth(value) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(value) || DEFAULT_WIDTH)));
}

function readStoredLayout() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || "null");
    return {
      collapsed: parsed?.collapsed === true,
      width: clampWidth(parsed?.width),
    };
  } catch {
    return { collapsed: false, width: DEFAULT_WIDTH };
  }
}

function suspendReplayPlayback() {
  useReplayStore.getState().requestSuspendPlayback();
}

export default function SidebarNav({ queueLength = 0, disabled = false }) {
  const [layout, setLayout] = useState(readStoredLayout);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef(null);
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const t = useT();

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout persistence is best-effort.
    }
  }, [layout]);

  useEffect(() => {
    if (!resizing) return undefined;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (event) => {
      const start = dragStartRef.current;
      if (!start) return;
      setLayout((current) => ({
        ...current,
        width: clampWidth(start.width + event.clientX - start.clientX),
      }));
    };
    const onPointerUp = () => {
      dragStartRef.current = null;
      setResizing(false);
    };
    globalThis.addEventListener("pointermove", onPointerMove);
    globalThis.addEventListener("pointerup", onPointerUp, { once: true });
    globalThis.addEventListener("pointercancel", onPointerUp, { once: true });
    return () => {
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
      globalThis.removeEventListener("pointercancel", onPointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  const collapsed = layout.collapsed;
  const visibleWidth = collapsed ? COLLAPSED_WIDTH : layout.width;
  const toggleCollapsed = () => setLayout((current) => ({
    ...current,
    collapsed: !current.collapsed,
  }));
  const runWindowAction = (action) => {
    void action().catch((error) => console.error("Sidebar action failed", error));
  };

  const resizeFromKeyboard = (event) => {
    let width = layout.width;
    if (event.key === "ArrowLeft") width -= 16;
    else if (event.key === "ArrowRight") width += 16;
    else if (event.key === "Home") width = MIN_WIDTH;
    else if (event.key === "End") width = MAX_WIDTH;
    else return;
    event.preventDefault();
    setLayout((current) => ({ ...current, width: clampWidth(width) }));
  };

  return (
    <aside
      className="app-sidebar relative flex h-screen shrink-0 flex-col border-r border-cs2-border-subtle bg-cs2-bg-sidebar text-cs2-text-primary"
      style={{ width: `${visibleWidth}px`, zIndex: SIDEBAR_Z_INDEX }}
      data-collapsed={collapsed ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
      data-testid="app-sidebar"
    >
      <div className="app-sidebar__header flex h-[50px] shrink-0 items-center border-b border-cs2-border-subtle px-2" data-tauri-drag-region>
        {!collapsed ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1" data-tauri-drag-region>
            <img
              src={`${import.meta.env.BASE_URL}cs2-insight-logo.png`}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-md"
              data-tauri-drag-region
            />
            <span className="truncate text-[13px] font-bold tracking-tight" data-tauri-drag-region>
              {t("nav.brand")}
            </span>
          </div>
        ) : <div className="flex-1" data-tauri-drag-region />}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-cs2-text-muted transition-colors hover:border-cs2-border hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
        >
          <PanelLeft className="h-[18px] w-[18px]" />
        </button>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-2"
        aria-label={t("nav.mainNav")}
        onPointerDownCapture={suspendReplayPlayback}
      >
        {!collapsed ? (
          <p className="px-2 pb-1 pt-2 text-[9px] font-bold uppercase tracking-[0.18em] text-cs2-text-muted">
            {t("nav.sectionWorkflow")}
          </p>
        ) : null}
        {NAV_ITEMS.map(({ to, end, labelKey, label, icon: Icon, queue, guarded }) => {
          const text = labelKey ? t(labelKey) : label;
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={collapsed ? text : undefined}
              title={collapsed ? text : undefined}
              aria-disabled={guarded && disabled ? true : undefined}
              className={({ isActive }) => [
                "app-sidebar__nav-item group relative flex h-10 shrink-0 items-center text-[12px] font-semibold transition-colors",
                collapsed ? "justify-center px-0" : "gap-3 px-2.5",
                isActive
                  ? "app-sidebar__nav-item--active bg-cs2-accent-soft text-cs2-accent"
                  : "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary",
                guarded && disabled ? "pointer-events-none opacity-40" : "",
              ].join(" ")}
            >
              <Icon className={`h-[18px] w-[18px] shrink-0 ${to === "/lite-cut" ? "text-cs2-amber-on-surface" : ""}`} />
              {!collapsed ? <span className="min-w-0 flex-1 truncate">{text}</span> : null}
              {queue ? (
                <span className={[
                  "flex items-center justify-center bg-cs2-accent font-mono font-black text-cs2-text-on-accent",
                  collapsed
                    ? "absolute right-0 top-0 h-4 min-w-4 rounded-full px-1 text-[8px]"
                    : "min-w-5 rounded-md px-1.5 text-[9px] leading-5",
                ].join(" ")}
                >
                  {queueLength}
                </span>
              ) : null}
            </NavLink>
          );
        })}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-cs2-border-subtle p-2">
        <div
          className={`flex h-5 items-center font-mono text-[9px] font-medium tracking-[0.08em] text-cs2-text-muted/65 ${
            collapsed ? "justify-center" : "justify-start px-2.5"
          }`}
          data-testid="sidebar-version"
          title={`v${APP_VERSION}`}
        >
          v{APP_VERSION}
        </div>
        <NavLink
          to="/settings"
          aria-label={collapsed ? t("nav.settings") : undefined}
          title={collapsed ? t("nav.settings") : undefined}
          className={({ isActive }) => [
            "flex h-9 items-center text-[11px] font-medium transition-colors",
            collapsed ? "justify-center" : "gap-3 px-2.5",
            isActive ? "bg-cs2-bg-active text-cs2-text-primary" : "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary",
          ].join(" ")}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed ? <span>{t("nav.settings")}</span> : null}
        </NavLink>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
          title={collapsed ? (theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")) : undefined}
          className={`flex h-9 w-full items-center text-[11px] font-medium text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary ${collapsed ? "justify-center" : "gap-3 px-2.5"}`}
        >
          {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
          {!collapsed ? <span>{theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}</span> : null}
        </button>
        <button
          type="button"
          aria-label={t("nav.openLogs")}
          title={collapsed ? t("nav.openLogs") : undefined}
          onClick={() => runWindowAction(() => API.post("config/open-logs"))}
          className={`flex h-9 w-full items-center text-[11px] font-medium text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary ${collapsed ? "justify-center" : "gap-3 px-2.5"}`}
        >
          <FileText className="h-4 w-4 shrink-0" />
          {!collapsed ? <span>{t("nav.openLogs")}</span> : null}
        </button>
      </div>

      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("nav.resize")}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={layout.width}
          tabIndex={0}
          title={t("nav.resizeHint")}
          className="app-sidebar__resize-handle absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none"
          onPointerDown={(event) => {
            dragStartRef.current = { clientX: event.clientX, width: layout.width };
            setResizing(true);
          }}
          onDoubleClick={() => setLayout((current) => ({ ...current, width: DEFAULT_WIDTH }))}
          onKeyDown={resizeFromKeyboard}
        />
      ) : null}
    </aside>
  );
}
