import { FolderOpen, RefreshCw, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { useAppShell } from "../context/AppShellContext";

export default function PlayerGameConfigPage() {
  const s = useAppShell();
  const st = s.configBackupStatus;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-4 sm:px-5">
      <div className="mb-6 shrink-0 border-b border-white/10 pb-4">
        <h1 className="text-lg font-bold text-white">玩家游戏配置</h1>
        <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-zinc-500">
          录制异常退出时，玩家本地 CS2 配置可能仍停留在备份状态。在此查看状态、从备份恢复 CFG，或打开备份目录手动处理。
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void s.refreshConfigBackupStatus()}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-cs2-orange/45 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            刷新状态
          </button>
          <button
            type="button"
            onClick={() => void s.handleOpenConfigBackupDir()}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-cs2-orange/45 hover:text-white"
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            打开备份目录
          </button>
        </div>

        {!st ? (
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-cs2-bg-card px-4 py-3 text-[12px] text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-cs2-orange" aria-hidden />
            正在读取配置备份状态…
          </div>
        ) : st.restore_required ? (
          <section
            className="rounded-xl border border-amber-500/45 bg-amber-500/10 px-4 py-4 shadow-sm"
            role="status"
          >
            <div className="flex flex-wrap items-start gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-bold text-amber-100">需要恢复玩家配置文件</p>
                <p className="text-[12px] leading-relaxed text-amber-100/85">
                  检测到上次录制过程中程序未正常结束，本地 CS2 配置可能尚未切回玩家目录。请先关闭 CS2，然后点击下方按钮恢复。
                </p>
                {typeof st.cs2_running === "boolean" && (
                  <p className="font-mono text-[11px] text-amber-200/90">
                    CS2 运行状态：{st.cs2_running ? "正在运行（须关闭后再恢复）" : "未检测到运行"}
                  </p>
                )}
                {st.backup_dir ? (
                  <p className="break-all font-mono text-[10px] leading-relaxed text-zinc-500">
                    备份目录：<span className="text-zinc-400">{st.backup_dir}</span>
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    className="rounded-md border border-amber-400/60 bg-amber-500/25 px-4 py-2 text-[12px] font-bold text-amber-50 hover:bg-amber-500/35"
                    onClick={() => void s.handleRestorePlayerConfig()}
                  >
                    一键恢复玩家配置
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-black/25 px-4 py-2 text-[12px] font-semibold text-zinc-200 hover:border-white/25"
                    onClick={() => void s.handleOpenConfigBackupDir()}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    打开备份目录
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-4">
            <div className="flex flex-wrap items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-bold text-emerald-100">配置文件状态正常</p>
                <p className="text-[12px] leading-relaxed text-emerald-100/80">
                  当前无需从备份恢复；仍可随时打开备份目录或手动替换文件。
                </p>
                {st.backup_dir ? (
                  <p className="break-all font-mono text-[10px] leading-relaxed text-zinc-500">
                    备份目录：<span className="text-zinc-400">{st.backup_dir}</span>
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/15 px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-cs2-orange/35"
                  onClick={() => void s.handleOpenConfigBackupDir()}
                >
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  打开备份目录
                </button>
              </div>
            </div>
          </section>
        )}

        {st?.message ? (
          <p className="rounded-lg border border-white/10 bg-cs2-bg-card px-3 py-2 font-mono text-[11px] text-zinc-400">
            {st.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
