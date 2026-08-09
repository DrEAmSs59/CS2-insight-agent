import { CheckSquare, XSquare, Loader2, ListPlus, Sparkles, Skull } from "lucide-react";
import { useT } from "../i18n/useT.js";

export default function ActionBar({
  selectedCount,
  totalCount,
  hasSelection,
  onSelectAll,
  onDeselectAll,
  onAddSelectedToQueue,
  onAddCurrentPlayerHighlights,
  onAddCurrentPlayerFails,
  currentPlayer,
  queueLength,
  batchRecording,
  canAddCurrentPlayerHighlights,
  canAddCurrentPlayerFails,
  sticky = false,
  compact = false,
}) {
  const t = useT();
  return (
    <div
      data-testid="clip-selection-action-bar"
      data-compact={compact ? "true" : "false"}
      className={`shrink-0 border-t border-cs2-border bg-cs2-bg-sidebar ${compact ? "px-3 py-2" : "px-4 py-3 sm:px-5"} ${
        sticky
          ? "sticky bottom-0 z-40 shadow-[0_-12px_30px_rgba(0,0,0,0.28)]"
          : ""
      }`}
    >
      <div className={compact ? "flex flex-wrap items-center justify-between gap-2" : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}>
        <div className={compact ? "flex items-center gap-2" : "flex flex-wrap items-center gap-4"}>
          <div className={`font-mono ${compact ? "text-[11px]" : "text-sm"}`}>
            <span className="font-bold text-cs2-accent">{selectedCount}</span>
            <span className="text-cs2-text-secondary"> {t("actionbar.selectedOf", { total: totalCount })}</span>
          </div>
          {!compact && currentPlayer ? (
            <span className="rounded border border-cs2-accent/25 bg-cs2-accent/[0.07] px-2 py-1 text-[10px] font-semibold text-cs2-accent">
              {t("actionbar.currentPlayerScope", { player: currentPlayer })}
            </span>
          ) : null}
          {!compact ? <div className="flex gap-1">
            <button
              type="button"
              onClick={onSelectAll}
              className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/30 hover:text-cs2-text-primary"
            >
              <CheckSquare className="h-3 w-3" />
              {t("actionbar.selectAll")}
            </button>
            <button
              type="button"
              onClick={onDeselectAll}
              className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/30 hover:text-cs2-text-primary"
            >
              <XSquare className="h-3 w-3" />
              {t("actionbar.deselect")}
            </button>
          </div> : null}
        </div>

        <div className={`flex flex-wrap items-center justify-end ${compact ? "gap-1.5" : "gap-2"}`}>
          {!compact && canAddCurrentPlayerHighlights && (
            <button
              type="button"
              disabled={batchRecording}
              onClick={onAddCurrentPlayerHighlights}
              className="flex items-center gap-2 rounded-lg border border-cs2-accent/35 bg-cs2-accent/10 px-4 py-2.5 text-xs font-bold text-cs2-accent transition-colors hover:border-cs2-accent/60 hover:bg-cs2-accent/15 disabled:opacity-30"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("actionbar.addCurrentPlayerHighlights", { player: currentPlayer })}
            </button>
          )}
          {!compact && canAddCurrentPlayerFails && (
            <button
              type="button"
              disabled={batchRecording}
              onClick={onAddCurrentPlayerFails}
              className="flex items-center gap-2 rounded-lg border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs font-bold text-rose-400 transition-colors hover:border-rose-500/60 hover:bg-rose-500/15 disabled:opacity-30"
            >
              <Skull className="h-3.5 w-3.5" />
              {t("actionbar.addCurrentPlayerFails", { player: currentPlayer })}
            </button>
          )}
          <button
            type="button"
            disabled={!hasSelection || batchRecording}
            onClick={onAddSelectedToQueue}
            className={`flex items-center rounded-md border border-cs2-border bg-cs2-bg-input font-extrabold text-cs2-text-primary transition-colors hover:border-cs2-accent/40 disabled:cursor-not-allowed disabled:opacity-30 ${compact ? "h-7 gap-1.5 px-3 text-[10px]" : "gap-2 px-5 py-2.5 text-xs uppercase tracking-wider"}`}
          >
            {batchRecording ? (
              <Loader2 className={`${compact ? "h-3 w-3" : "h-4 w-4"} animate-spin`} />
            ) : (
              <ListPlus className={`${compact ? "h-3 w-3" : "h-4 w-4"} text-cs2-accent`} />
            )}
            {t("actionbar.addSelected")}
          </button>
        </div>
      </div>
      {!compact && queueLength > 0 && (
        <p className="mt-2 text-center font-mono text-[11px] text-cs2-text-muted sm:text-left">
          {t("actionbar.queueCount", { n: queueLength })}
        </p>
      )}
    </div>
  );
}
