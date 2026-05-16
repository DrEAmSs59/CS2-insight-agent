import { NavLink } from "react-router-dom";
import {
  BookOpen,
  Library,
  Microscope,
  Package,
  Clapperboard,
  SlidersHorizontal,
  Settings,
  Gamepad2,
  RadioTower,
  Sun,
  Moon,
} from "lucide-react";
import { useThemeStore } from "../stores/themeStore";

const linkBase =
  "flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-semibold transition-colors border border-transparent";
const linkIdle = "text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary";
const linkActive = "border-cs2-accent/45 bg-cs2-accent-soft text-cs2-accent";

function SectionLabel({ children }) {
  return (
    <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-cs2-text-muted">
      {children}
    </div>
  );
}

export default function SidebarNav({ queueLength = 0, disabled = false }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  return (
    <aside className="flex w-48 shrink-0 flex-col border-r border-cs2-border bg-cs2-bg-sidebar">
      <div className="border-b border-cs2-border px-2.5 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src="/cs2-insight-logo.png"
            alt="CS2 洞察"
            width={64}
            height={64}
            decoding="async"
            className={`h-16 w-16 shrink-0 object-contain ${theme === "dark" ? "mix-blend-lighten" : "invert mix-blend-darken opacity-90"}`}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold tracking-wide text-cs2-text-primary">CS2 洞察</div>
            <div className="font-mono text-[10px] tracking-widest text-cs2-text-muted">v2.0.1</div>
          </div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-2" aria-label="主导航">
        <SectionLabel>工作流</SectionLabel>
        <NavLink to="/" end className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <BookOpen className="h-4 w-4 shrink-0 opacity-90" />
          上手指南
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Library className="h-4 w-4 shrink-0 opacity-90" />
          Demo 库
        </NavLink>
        <NavLink to="/analysis" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Microscope className="h-4 w-4 shrink-0 opacity-90" />
          解析分析
        </NavLink>
        <NavLink
          to="/queue"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle} ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <Package className="h-4 w-4 shrink-0 opacity-90" />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span>录制队列</span>
            <span className="rounded bg-cs2-accent/20 px-1.5 font-mono text-[10px] tabular-nums text-cs2-text-primary">{queueLength}</span>
          </span>
        </NavLink>
        <NavLink
          to="/montage"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle} ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <Clapperboard className="h-4 w-4 shrink-0 opacity-90" />
          合辑工作台
        </NavLink>

        <SectionLabel>工具</SectionLabel>
        <NavLink to="/params" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <SlidersHorizontal className="h-4 w-4 shrink-0 opacity-90" />
          常用参数
        </NavLink>
        <NavLink to="/obs-config-center" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <RadioTower className="h-4 w-4 shrink-0 opacity-90" />
          OBS 配置中心
        </NavLink>
        <NavLink to="/player-game-config" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Gamepad2 className="h-4 w-4 shrink-0 opacity-90" />
          玩家游戏配置
        </NavLink>
      </nav>

      {/* 底部：设置 + 主题切换 */}
      <div className="border-t border-cs2-border px-1.5 py-2 space-y-1">
        <NavLink to="/settings" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Settings className="h-4 w-4 shrink-0 opacity-90" />
          设置
        </NavLink>
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
          {theme === "dark" ? "切换亮色" : "切换暗色"}
        </button>
      </div>
    </aside>
  );
}
