import { CheckSquare, XSquare, Loader2, ListPlus, Sparkles } from "lucide-react";

export default function ActionBar({
  selectedCount,
  totalCount,
  hasSelection,
  onSelectAll,
  onDeselectAll,
  onAddSelectedToQueue,
  onAddAllHighlightsAllMatches,
  queueLength,
  batchRecording,
  canAddAllHighlights,
}) {
  return (
    <div className="border-t border-cs2-border bg-cs2-bg-sidebar px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <div className="font-mono text-sm">
            <span className="font-bold text-cs2-orange">{selectedCount}</span>
            <span className="text-cs2-text-secondary"> / {totalCount} 个常规片段已选中</span>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onSelectAll}
              className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-orange/30 hover:text-white"
            >
              <CheckSquare className="h-3 w-3" />
              全选
            </button>
            <button
              type="button"
              onClick={onDeselectAll}
              className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-orange/30 hover:text-white"
            >
              <XSquare className="h-3 w-3" />
              取消
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {canAddAllHighlights && (
            <button
              type="button"
              disabled={batchRecording}
              onClick={onAddAllHighlightsAllMatches}
              className="flex items-center gap-2 rounded-lg border border-cs2-orange/35 bg-cs2-orange/10 px-4 py-2.5 text-xs font-bold text-cs2-orange transition-colors hover:border-cs2-orange/60 hover:bg-cs2-orange/15 disabled:opacity-30"
            >
              <Sparkles className="h-3.5 w-3.5" />
              全部场次高光入队
            </button>
          )}
          <button
            type="button"
            disabled={!hasSelection || batchRecording}
            onClick={onAddSelectedToQueue}
            className="flex items-center gap-2 rounded-lg border border-white/15 bg-cs2-bg-input px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-white transition-colors hover:border-cs2-orange/40 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {batchRecording ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ListPlus className="h-4 w-4 text-cs2-orange" />
            )}
            将选中片段加入队列
          </button>
        </div>
      </div>
      {queueLength > 0 && (
        <p className="mt-2 text-center font-mono text-[10px] text-zinc-500 sm:text-left">
          当前队列 {queueLength} 条 — 点击右侧「录制队列」进行批量导出
        </p>
      )}
    </div>
  );
}
