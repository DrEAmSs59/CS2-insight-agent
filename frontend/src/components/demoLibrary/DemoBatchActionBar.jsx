import { useT } from "../../i18n/useT.js";

export default function DemoBatchActionBar({
  count,
  onLoadSelected,
  onOpenBatchModal,
  onBatchDelete,
  onClearSelection,
}) {
  const t = useT();

  if (count <= 0) return null;

  const btn =
    "rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/40 hover:text-cs2-text-primary";

  const btnPrimary =
    "rounded-md border border-cs2-accent/45 bg-cs2-accent/10 px-2.5 py-1.5 text-[12px] font-bold text-cs2-accent hover:border-cs2-accent/70";

  const btnDanger =
    "rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[12px] font-semibold text-cs2-red-on-surface hover:border-red-500/55";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-cs2-border bg-cs2-bg-card/90 px-3 py-2 backdrop-blur-[1px]">
      <span className="text-[12px] font-semibold tabular-nums text-cs2-text-secondary">
        {t("library.batchSelected", { count })}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <button type="button" className={btn} onClick={() => void onLoadSelected()}>
          {t("library.batchLoad")}
        </button>
        <button type="button" className={btnPrimary} onClick={onOpenBatchModal}>
          {t("library.batchLoadParse")}
        </button>
        <button type="button" className={btnDanger} onClick={() => void onBatchDelete()}>
          {t("library.batchDelete")}
        </button>
        <button type="button" className={btn} onClick={onClearSelection}>
          {t("library.batchClear")}
        </button>
      </div>
    </div>
  );
}
