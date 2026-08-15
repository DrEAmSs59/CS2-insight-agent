import { useT } from "../../../i18n/useT.js";

export default function DemoBatchActionBar({
  count,
  onLoadSelected,
  onBatchDelete,
  onClearSelection,
}) {
  const t = useT();

  if (count <= 0) return null;

  const btn =
    "rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/40 hover:text-cs2-text-primary";

  const btnDanger =
    "rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[12px] font-semibold text-cs2-red-on-surface hover:border-red-500/55";

  return (
    <div
      data-testid="demo-library-selection-bar"
      className="flex max-w-full shrink-0 flex-wrap items-center gap-1 rounded-lg border border-cs2-accent/30 bg-cs2-accent/5 p-1"
    >
      <span className="whitespace-nowrap px-1.5 text-[12px] font-semibold tabular-nums text-cs2-accent">
        {t("library.batchSelected", { count })}
      </span>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button type="button" className={btn} onClick={() => void onLoadSelected()}>
          {t("library.batchLoad")}
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
