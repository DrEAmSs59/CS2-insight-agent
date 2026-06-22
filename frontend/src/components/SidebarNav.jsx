import { NavLink } from "react-router-dom";
import {
  BookOpen,
  Library,
  Microscope,
  Package,
  Clapperboard,
  Download,
  Settings,
  Sun,
  Moon,
} from "lucide-react";
import { useThemeStore } from "../stores/themeStore";
import { useT } from "../i18n/useT.js";

const linkBase =
  "flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-semibold transition-colors border border-transparent";
const linkIdle = "text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary";
const linkActive = "border-cs2-accent/45 bg-cs2-accent-soft text-cs2-accent";

export default function SidebarNav({ queueLength = 0, disabled = false, onCheckUpdate }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const t = useT();

  return (
    <aside className="flex w-48 shrink-0 flex-col border-r border-cs2-border bg-cs2-bg-sidebar">
      <div className="border-b border-cs2-border px-2.5 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src="/cs2-insight-logo-new.png"
            alt={t("nav.brand")}
            width={64}
            height={64}
            decoding="async"
            className="h-16 w-16 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold tracking-wide text-cs2-text-primary">{t("nav.brand")}</div>
            <div className="font-mono text-[10px] tracking-widest text-cs2-text-muted">v{__APP_VERSION__}</div>
          </div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-2" aria-label={t("nav.mainNav")}>
        <NavLink to="/" end className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <BookOpen className="h-4 w-4 shrink-0 opacity-90" />
          {t("nav.guide")}
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Library className="h-4 w-4 shrink-0 opacity-90" />
          {t("nav.demoLibrary")}
        </NavLink>
        <NavLink to="/analysis" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Microscope className="h-4 w-4 shrink-0 opacity-90" />
          {t("nav.analysis")}
        </NavLink>
        <NavLink
          to="/queue"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle} ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <Package className="h-4 w-4 shrink-0 opacity-90" />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span>{t("nav.recordQueue")}</span>
            <span className="rounded bg-cs2-accent/20 px-1.5 font-mono text-[10px] tabular-nums text-cs2-text-primary">{queueLength}</span>
          </span>
        </NavLink>
        <NavLink
          to="/montage"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle} ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <Clapperboard className="h-4 w-4 shrink-0 opacity-90" />
          {t("nav.montage")}
        </NavLink>
      </nav>

      <div className="space-y-1 border-t border-cs2-border px-1.5 py-2">
        <NavLink to="/settings" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Settings className="h-4 w-4 shrink-0 opacity-90" />
          {t("nav.settings")}
        </NavLink>
        {/* <button
          type="button"
          disabled={disabled || !onCheckUpdate}
          onClick={() => onCheckUpdate?.()}
          className={`${linkBase} w-full text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary disabled:pointer-events-none disabled:opacity-40`}
        >
          <Download className="h-4 w-4 shrink-0 opacity-90" />
          检查更新
        </button> */}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-semibold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4 shrink-0 opacity-90" />
          ) : (
            <Moon className="h-4 w-4 shrink-0 opacity-90" />
          )}
          {theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")}
        </button>
      </div>
    </aside>
  );
}
