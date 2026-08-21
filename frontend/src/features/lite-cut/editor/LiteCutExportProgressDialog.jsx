import { CheckCircle2, Copy, FolderOpen, Loader2, TriangleAlert, X } from "lucide-react";
import { liteCutClient } from "../api/liteCutClient.js";
import { desktopBridge } from "../../../desktop/desktopBridge.js";
import { writeLiteCutClipboardText } from "./liteCutClipboard.js";

function basenameFromPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function exportStageLabel(result) {
  const rawStage = String(result?.stage || result?.status || "");
  const fallback = rawStage.startsWith("fallback_");
  const stage = fallback ? rawStage.slice("fallback_".length) : rawStage;
  const label = {
    queued: "排队中",
    starting: "准备导出",
    checking: "检查素材",
    normalizing: "规范化片段",
    transitions: "合成转场",
    concat: "拼接主轨",
    finalizing: "封装成片",
    validating: "校验成片",
    overlays: "合成叠加层",
    audio: "混音",
    range: "裁剪输出范围",
    framemeld: "FrameMeld 自动运动渲染",
    done: "完成",
    cancelling: "正在取消",
    cancelled: "已取消",
    error: "失败",
  }[stage] || stage || "导出中";
  return fallback ? `切换兼容编码 · ${label}` : label;
}

export default function LiteCutExportProgressDialog({
  phase = "idle",
  result = null,
  error = "",
  onClose,
  onCancel,
  variant = "liteCut",
}) {
  if (phase === "idle") return null;
  const outputPath = result?.output_path || "";
  const fileName = basenameFromPath(outputPath);
  const progressPct = Math.round(Math.max(0, Math.min(1, Number(result?.progress) || 0)) * 100);
  const running = phase === "running";
  const elapsedText = formatDuration(result?.elapsed_seconds);
  const etaSeconds = Number(result?.estimated_remaining_seconds);
  const hasEta = Number.isFinite(etaSeconds) && etaSeconds >= 0;
  const processedFrames = Number(result?.processed_frames);
  const totalFrames = Number(result?.total_frames);
  const hasFrameProgress = Number.isFinite(processedFrames) && Number.isFinite(totalFrames) && totalFrames > 0;
  const montage = variant === "montage";
  const encoderWarning = result?.encoder_warning?.code === "NVIDIA_DRIVER_TOO_OLD"
    ? result.encoder_warning
    : null;
  const nvencApiDetail = encoderWarning?.found_nvenc_api && encoderWarning?.required_nvenc_api
    ? `当前 NVENC API ${encoderWarning.found_nvenc_api}，要求 ${encoderWarning.required_nvenc_api}。`
    : "";
  const minimumDriverDetail = encoderWarning?.minimum_driver_version
    ? `建议 NVIDIA 驱动升级至 ${encoderWarning.minimum_driver_version} 或更高版本。`
    : "";
  const runningTitle = montage ? "正在导出合辑…" : "正在导出成片…";
  const runningSubtitle = montage ? "FFmpeg 真实合成 · 请保持程序运行" : "FFmpeg 真实合成 · 预览不参与导出";
  const dialogSubtitle = !running && montage ? "合辑已保存到指定目录" : runningSubtitle;
  const pipelineLabel = montage ? "片段 · 转场 · 片头片尾 · 音频 · 成片校验" : "视频 · 转场 · 叠加层 · 音频 · 调色";
  const doneButtonLabel = montage ? "返回合辑工作台" : "返回 LiteCut 首页";

  const copyPath = async () => {
    if (!outputPath) return;
    await writeLiteCutClipboardText(outputPath);
  };

  const revealOutput = async () => {
    if (!outputPath) return;
    try {
      if (desktopBridge?.showItemInFolder && await desktopBridge.showItemInFolder(outputPath)) return;
      await liteCutClient.revealFile(outputPath);
    } catch {
      // Keep the completed export visible even if Explorer could not open.
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="导出进度">
      <div className="w-full max-w-md rounded-2xl border border-cs2-border bg-cs2-bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-cs2-text-primary">{running ? runningTitle : phase === "done" ? "导出完成" : phase === "cancelled" ? "导出已取消" : "导出失败"}</p>
            <p className="mt-1 text-xs text-cs2-text-muted">{dialogSubtitle}</p>
          </div>
          {!running ? <button type="button" aria-label="关闭导出窗口" onClick={onClose} className="rounded-lg p-1 text-cs2-text-muted hover:bg-cs2-surface-2"><X className="h-4 w-4" /></button> : null}
        </div>

        {running ? <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2 text-xs text-cs2-text-secondary"><Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />{pipelineLabel}</div>
          <div className="flex items-center justify-between text-[11px] font-semibold text-cs2-text-secondary"><span>{exportStageLabel(result)} · 任务 #{result?.export_id || "-"}</span><span className="font-mono text-cs2-text-primary">{progressPct}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-cs2-bg-input"><div className="h-full rounded-full bg-cs2-accent transition-[width]" style={{ width: `${Math.max(4, progressPct)}%` }} /></div>
          <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-cs2-text-muted">
            <span>已用时间 {elapsedText}</span>
            <span>{hasEta ? `预计剩余 ${formatDuration(etaSeconds)}` : "正在计算剩余时间"}</span>
          </div>
          {hasFrameProgress ? (
            <p className="font-mono text-[11px] text-cs2-text-muted">Blur 帧进度 {processedFrames} / {totalFrames}</p>
          ) : (
            <p className="font-mono text-[11px] text-cs2-text-muted">请稍候，导出正在后台执行…</p>
          )}
          {onCancel ? <button type="button" onClick={onCancel} className="w-full rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary hover:border-rose-400/60 hover:text-rose-300">取消导出</button> : null}
          {encoderWarning ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-amber-200" role="status">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 text-[11px] leading-relaxed">
                <p className="font-semibold">检测到 NVIDIA 驱动版本过低，已自动切换至 CPU 编码。导出速度会明显变慢，建议更新驱动后重试。</p>
                {nvencApiDetail || minimumDriverDetail ? (
                  <p className="mt-1 text-amber-200/80">{nvencApiDetail}{nvencApiDetail && minimumDriverDetail ? " " : ""}{minimumDriverDetail}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div> : null}

        {phase === "done" ? <div className="mt-5 space-y-4">
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-200"><CheckCircle2 className="h-5 w-5 shrink-0" /><div className="min-w-0"><p className="text-xs font-bold">{fileName || "export.mp4"}</p><p className="mt-0.5 truncate font-mono text-[10px] opacity-80">{outputPath}</p></div></div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!outputPath} onClick={() => void revealOutput()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" />打开文件夹</button>
            <button type="button" disabled={!outputPath} onClick={() => void copyPath()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary disabled:opacity-40"><Copy className="h-3.5 w-3.5" />复制路径</button>
          </div>
          <button type="button" onClick={onClose} className="w-full rounded-lg bg-cs2-accent py-2.5 text-center text-xs font-bold text-dynamic-white">{doneButtonLabel}</button>
        </div> : null}

        {phase === "cancelled" || phase === "error" ? <div className="mt-5 space-y-3">
          <p className={`rounded-lg border px-3 py-2 text-xs ${phase === "error" ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>{phase === "error" ? (error || "导出失败") : "导出任务已停止，未生成新的成片。"}</p>
          <button type="button" onClick={onClose} className="w-full rounded-lg border border-cs2-border py-2 text-xs font-semibold text-cs2-text-secondary">关闭</button>
        </div> : null}
      </div>
    </div>
  );
}
