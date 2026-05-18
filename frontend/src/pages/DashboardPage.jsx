import { Link } from "react-router-dom";
import {
  Library,
  Microscope,
  Package,
  Clapperboard,
  SlidersHorizontal,
  Settings,
  Brain,
  Zap,
  Gamepad2,
} from "lucide-react";
import { useAppShell } from "../context/AppShellContext";

export default function DashboardPage() {
  const s = useAppShell();
  const nDemos = s.uploadedDemos?.length ?? 0;
  const q = s.queue?.length ?? 0;
  const libTotal = s.libraryTotal;

  const cards = [
    { to: "/library", label: "Demo 库", desc: "搜索、筛选、载入解析", icon: Library, hint: libTotal != null ? `共 ${libTotal} 条` : "浏览本地库" },
    { to: "/analysis", label: "解析分析", desc: "上传、选玩家、看片段", icon: Microscope, hint: nDemos ? `已导入 ${nDemos} 个` : "上传 .dem 开始" },
    { to: "/queue", label: "录制队列", desc: "批量 OBS 录制", icon: Package, hint: `${q} 条待录` },
    { to: "/montage", label: "合辑工作台", desc: "已录片段拼接导出", icon: Clapperboard, hint: "时间线与主题" },
    { to: "/params", label: "常用参数", desc: "全局节奏与观战默认", icon: SlidersHorizontal, hint: "写入配置文件" },
    {
      to: "/player-game-config",
      label: "玩家游戏配置",
      desc: "CFG 备份与恢复",
      icon: Gamepad2,
      hint: "异常退出后恢复",
    },
    { to: "/settings", label: "设置", desc: "OBS · CS2 · LLM", icon: Settings, hint: "连接与环境" },
  ];

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-4 sm:px-5">
      <div className="mb-6 shrink-0 border-b border-cs2-border pb-5">
        <h1 className="text-xl font-bold text-cs2-text-primary">仪表盘</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-cs2-text-muted">
          选择下方入口进入对应功能。解析高光、管理录制队列与合辑导出已分为独立页面，左侧导航可随时切换。
        </p>
        <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2 text-[11px] text-cs2-text-secondary">
          <span className="font-semibold text-cs2-text-muted">分析模式</span>
          {s.aiMode ? (
            <span className="inline-flex items-center gap-1 font-bold text-cs2-accent">
              <Brain className="h-3.5 w-3.5" /> AI 洞察
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-bold text-cs2-text-secondary">
              <Zap className="h-3.5 w-3.5" /> 极速本地
            </span>
          )}
          <span className="text-cs2-text-muted">·</span>
          <Link to="/settings" className="text-cs2-accent hover:underline">
            在设置中切换
          </Link>
        </div>
      </div>

      <div className="grid min-h-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map(({ to, label, desc, icon: Icon, hint }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-xl border border-cs2-border bg-cs2-bg-card/90 px-4 py-4 transition-colors hover:border-cs2-accent/35 hover:bg-cs2-bg-card"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cs2-accent/15 text-cs2-accent transition-colors group-hover:bg-cs2-accent/25">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-cs2-text-primary">{label}</p>
                <p className="mt-1 text-[12px] leading-snug text-cs2-text-muted">{desc}</p>
                <p className="mt-2 font-mono text-[10px] text-cs2-text-muted">{hint}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
