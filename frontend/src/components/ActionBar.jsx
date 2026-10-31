import { Loader2, Plus } from "lucide-react";
import { useT } from "../i18n/useT.js";

export default function ActionBar({
  selectedCount,
  totalCount,
  hasSelection,
  onSelectAll,
  onDeselectAll,
  onAddSelectedToQueue,
  batchRecording,
  sticky = false,
  compact = false,
}) {
  const t = useT();
  const ghost = "inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-cs2-accent transition-colors hover:bg-cs2-bg-hover";
  return (
    <div
      data-testid="clip-selection-action-bar"
      data-compact={compact ? "true" : "false"}
      className={`shrink-0 border-t border-cs2-border-subtle bg-cs2-bg-sidebar ${compact ? "px-3 py-2" : "px-4 py-2.5"} ${
        sticky
          ? "sticky bottom-0 z-40 shadow-[0_-12px_30px_rgba(0,0,0,0.28)]"
          : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-[12.5px] text-cs2-text-secondary">
          <span className="mr-1">
            {t("actionbar.selectedSummary", { n: selectedCount, total: totalCount })}
          </span>
          {!compact ? (
            <>
              <button type="button" onClick={onSelectAll} className={ghost}>{t("actionbar.selectAll")}</button>
              <button type="button" onClick={onDeselectAll} className={ghost}>{t("actionbar.deselect")}</button>
            </>
          ) : null}
        </div>

        <div className={`flex flex-wrap items-center justify-end ${compact ? "gap-1.5" : "gap-2"}`}>
          <button
            type="button"
            disabled={!hasSelection || batchRecording}
            onClick={onAddSelectedToQueue}
            className={`inline-flex items-center gap-1.5 rounded-md border border-cs2-accent bg-cs2-accent font-semibold text-black transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 ${compact ? "h-7 px-2.5 text-[11px]" : "h-8 px-3.5 text-xs"}`}
          >
            {batchRecording ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            {t("actionbar.addSelectedCount", { n: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}
