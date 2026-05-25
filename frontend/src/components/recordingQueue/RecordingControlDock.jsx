import { Link } from "react-router-dom";
import { Play, Square, Trash2, Layers, Timer, Settings2 } from "lucide-react";

/**
 * @param {{
 *   queueLength: number,
 *   totalEstimateSec: number,
 *   batchRecording: boolean,
 *   onStart: () => void,
 *   onAbort: () => void,
 *   onClear: () => void,
 *   disabledStart: boolean,
 *   obsConfigured: boolean,
 * }} props
 */
export default function RecordingControlDock({
  queueLength,
  totalEstimateSec,
  batchRecording,
  onStart,
  onAbort,
  onClear,
  disabledStart,
  obsConfigured,
}) {
  const estLabel =
    totalEstimateSec <= 0
      ? "—"
      : totalEstimateSec >= 3600
        ? `${Math.floor(totalEstimateSec / 3600)}h ${Math.round((totalEstimateSec % 3600) / 60)}m`
        : `${Math.max(1, Math.round(totalEstimateSec / 60))} min`;

  const statusLabel = batchRecording ? "录制中" : queueLength ? "就绪" : "空闲";
  const startDisabled = disabledStart;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-4 border-t border-cs2-border bg-cs2-bg-page/95 px-4 py-3 backdrop-blur-md sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-cs2-text-muted">
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3 text-cs2-text-muted" />
          <span className="text-cs2-text-muted">任务</span>
          <span className="tabular-nums text-cs2-text-secondary">{queueLength}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3 text-cs2-text-muted" />
          <span className="text-cs2-text-muted">预计</span>
          <span className="tabular-nums text-cs2-text-secondary">{estLabel}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${batchRecording ? "animate-pulse bg-emerald-400" : "bg-zinc-600"}`}
          />
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <div className="flex flex-col items-end gap-0.5">
          <button
            type="button"
            disabled={startDisabled}
            onClick={() => onStart()}
            className="inline-flex items-center gap-1.5 rounded-md bg-cs2-accent px-3 py-2 text-[12px] font-bold text-cs2-text-on-accent shadow-sm shadow-cs2-accent/20 transition-colors hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Play className="h-3.5 w-3.5" />
            开始录制
          </button>
        </div>
        <button
          type="button"
          disabled={!batchRecording}
          onClick={() => void onAbort()}
          className="inline-flex items-center gap-1 rounded-md border border-cs2-border px-2.5 py-2 text-[12px] font-semibold text-cs2-text-secondary transition-colors hover:border-red-500/40 hover:text-cs2-red-on-surface disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Square className="h-3.5 w-3.5" />
          停止
        </button>
        <button
          type="button"
          disabled={queueLength === 0 || batchRecording}
          onClick={() => onClear()}
          className="inline-flex items-center gap-1 rounded-md border border-cs2-border px-2.5 py-2 text-[12px] font-semibold text-cs2-text-muted transition-colors hover:border-red-500/35 hover:text-cs2-red-on-surface disabled:opacity-30"
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cs2-border pt-2 sm:ml-auto sm:border-t-0 sm:pt-0">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 rounded-md border border-cs2-border px-2 py-1.5 text-[11px] font-semibold text-cs2-text-muted transition-colors hover:border-cs2-accent/35 hover:text-cs2-text-secondary"
        >
          <Settings2 className="h-3 w-3" />
          OBS / 输出
        </Link>
      </div>
    </div>
  );
}
