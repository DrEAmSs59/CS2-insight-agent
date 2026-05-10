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
} from "lucide-react";

const linkBase =
  "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors border border-transparent";
const linkIdle = "text-zinc-400 hover:border-white/10 hover:bg-white/[0.04] hover:text-zinc-200";
const linkActive = "border-cs2-orange/45 bg-cs2-orange/10 text-cs2-orange";

export default function SidebarNav({ queueLength = 0, disabled = false }) {
  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-cs2-border bg-cs2-bg-sidebar">
      <div className="border-b border-cs2-border px-2.5 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src="/cs2-insight-logo.png"
            alt="CS2 洞察"
            width={72}
            height={72}
            decoding="async"
            className="h-[72px] w-[72px] shrink-0 object-contain mix-blend-lighten"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold tracking-wide text-white">CS2 洞察</div>
            <div className="font-mono text-[10px] tracking-widest text-cs2-text-secondary">v2.0.0</div>
          </div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-2" aria-label="主导航">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}
        >
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
            <span className="rounded bg-cs2-orange/20 px-1.5 font-mono text-[10px] tabular-nums text-white">{queueLength}</span>
          </span>
        </NavLink>
        <NavLink
          to="/montage"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle} ${disabled ? "pointer-events-none opacity-40" : ""}`}
        >
          <Clapperboard className="h-4 w-4 shrink-0 opacity-90" />
          合辑工作台
        </NavLink>
        <NavLink to="/params" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <SlidersHorizontal className="h-4 w-4 shrink-0 opacity-90" />
          常用参数
        </NavLink>
        <NavLink to="/obs-config-center" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <RadioTower className="h-4 w-4 shrink-0 opacity-90" />
          OBS 配置中心
        </NavLink>
        <NavLink
          to="/player-game-config"
          className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}
        >
          <Gamepad2 className="h-4 w-4 shrink-0 opacity-90" />
          玩家游戏配置
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
          <Settings className="h-4 w-4 shrink-0 opacity-90" />
          设置
        </NavLink>
      </nav>
    </aside>
  );
}
