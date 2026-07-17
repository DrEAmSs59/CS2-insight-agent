import { CheckCircle2, Copy, FolderOpen, Loader2, X } from "lucide-react";
import API from "../../../api/api.js";

function basenameFromPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function exportStageLabel(result) {
  return {
    queued: "排队中",
    starting: "准备导出",
    checking: "检查素材",
    normalizing: "规范化片段",
    transitions: "合成转场",
    concat: "拼接主轨",
    overlays: "合成叠加层",
    audio: "混音",
    done: "完成",
    cancelling: "正在取消",
    cancelled: "已取消",
    error: "失败",
  }[result?.stage || result?.status] || result?.stage || result?.status || "导出中";
}

export default function LiteCutExportProgressDialog({ phase = "idle", result = null, error = "", onClose, onCancel }) {
  if (phase === "idle") return null;
  const outputPath = result?.output_path || "";
  const fileName = basenameFromPath(outputPath);
  const progressPct = Math.round(Math.max(0, Math.min(1, Number(result?.progress) || 0)) * 100);
  const running = phase === "running";

  const copyPath = async () => {
    if (!outputPath) return;
    try {
      await navigator.clipboard.writeText(outputPath);
    } catch {
      // Clipboard access may be unavailable outside Electron.
    }
  };

  const revealOutput = async () => {
    if (!outputPath) return;
    try {
      if (window.electron?.showItemInFolder && await window.electron.showItemInFolder(outputPath)) return;
      await API.post("/reveal-file-in-explorer", { path: outputPath });
    } catch {
      // Keep the completed export visible even if Explorer could not open.
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="导出进度">
      <div className="w-full max-w-md rounded-2xl border border-cs2-border bg-cs2-bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-cs2-text-primary">{running ? "正在导出成片…" : phase === "done" ? "导出完成" : phase === "cancelled" ? "导出已取消" : "导出失败"}</p>
            <p className="mt-1 text-xs text-cs2-text-muted">FFmpeg 真实合成 · 预览不参与导出</p>
          </div>
          {!running ? <button type="button" aria-label="关闭导出窗口" onClick={onClose} className="rounded-lg p-1 text-cs2-text-muted hover:bg-cs2-surface-2"><X className="h-4 w-4" /></button> : null}
        </div>

        {running ? <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2 text-xs text-cs2-text-secondary"><Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />视频 · 转场 · 叠加层 · 音频 · 调色</div>
          <div className="flex items-center justify-between text-[11px] font-semibold text-cs2-text-secondary"><span>{exportStageLabel(result)} · 任务 #{result?.export_id || "-"}</span><span className="font-mono text-cs2-text-primary">{progressPct}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-cs2-bg-input"><div className="h-full rounded-full bg-cs2-accent transition-[width]" style={{ width: `${Math.max(4, progressPct)}%` }} /></div>
          <p className="font-mono text-[11px] text-cs2-text-muted">请稍候，导出正在后台执行…</p>
          <button type="button" onClick={onCancel} className="w-full rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary hover:border-rose-400/60 hover:text-rose-300">取消导出</button>
        </div> : null}

        {phase === "done" ? <div className="mt-5 space-y-4">
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-200"><CheckCircle2 className="h-5 w-5 shrink-0" /><div className="min-w-0"><p className="text-xs font-bold">{fileName || "export.mp4"}</p><p className="mt-0.5 truncate font-mono text-[10px] opacity-80">{outputPath}</p></div></div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!outputPath} onClick={() => void revealOutput()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" />打开文件夹</button>
            <button type="button" disabled={!outputPath} onClick={() => void copyPath()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary disabled:opacity-40"><Copy className="h-3.5 w-3.5" />复制路径</button>
          </div>
          <button type="button" onClick={onClose} className="w-full rounded-lg bg-cs2-accent py-2.5 text-center text-xs font-bold text-dynamic-white">返回 LiteCut 首页</button>
        </div> : null}

        {phase === "cancelled" || phase === "error" ? <div className="mt-5 space-y-3">
          <p className={`rounded-lg border px-3 py-2 text-xs ${phase === "error" ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>{phase === "error" ? (error || "导出失败") : "导出任务已停止，未生成新的成片。"}</p>
          <button type="button" onClick={onClose} className="w-full rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary">关闭</button>
        </div> : null}
      </div>
    </div>
  );
}
