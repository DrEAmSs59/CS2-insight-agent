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
 *   obsConnected: boolean | null,
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
  obsConnected,
}) {
  const estLabel =
    totalEstimateSec <= 0
      ? "—"
      : totalEstimateSec >= 3600
        ? `${Math.floor(totalEstimateSec / 3600)}h ${Math.round((totalEstimateSec % 3600) / 60)}m`
        : `${Math.max(1, Math.round(totalEstimateSec / 60))} min`;

  const statusLabel = batchRecording ? "录制中" : queueLength ? "就绪" : "空闲";
  const obsDisconnected = obsConnected === false;
  const startDisabled = disabledStart || obsDisconnected;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-white/10 bg-[#0d0d10]/95 px-3 py-2.5 backdrop-blur-md sm:gap-4 sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3 text-zinc-600" />
          <span className="text-zinc-600">任务</span>
          <span className="tabular-nums text-zinc-300">{queueLength}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3 text-zinc-600" />
          <span className="text-zinc-600">预计</span>
          <span className="tabular-nums text-zinc-300">{estLabel}</span>
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
            className="inline-flex items-center gap-1.5 rounded-md bg-cs2-orange px-3 py-2 text-[11px] font-bold text-black shadow-sm shadow-cs2-orange/20 transition-colors hover:bg-cs2-orange-light disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Play className="h-3.5 w-3.5" />
            开始录制
          </button>
          {obsDisconnected && !batchRecording && (
            <span className="text-[9px] font-medium text-red-400/80">OBS 未连接</span>
          )}
        </div>
        <button
          type="button"
          disabled={!batchRecording}
          onClick={() => void onAbort()}
          className="inline-flex items-center gap-1 rounded-md border border-white/12 px-2.5 py-2 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Square className="h-3.5 w-3.5" />
          停止
        </button>
        <button
          type="button"
          disabled={queueLength === 0 || batchRecording}
          onClick={() => onClear()}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-2 text-[11px] font-semibold text-zinc-500 transition-colors hover:border-red-500/35 hover:text-red-300 disabled:opacity-30"
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] pt-2 sm:ml-auto sm:border-t-0 sm:pt-0">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1.5 text-[10px] font-semibold text-zinc-500 transition-colors hover:border-cs2-orange/35 hover:text-zinc-300"
        >
          <Settings2 className="h-3 w-3" />
          OBS / 输出
        </Link>
      </div>
    </div>
  );
}
