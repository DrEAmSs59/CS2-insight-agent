import { Database, FilePlus2, FolderOpen, LayoutGrid, List, Loader2, ScanSearch } from "lucide-react";
import { useT } from "../../i18n/useT.js";

export default function DemoLibraryToolbar({
  onOpenWatchPaths,
  onScan,
  onOpenIngest,
  onOpenLocalDemo,
  libraryLoading,
  libraryScanning,
  pageSelectableCount,
  libraryTotal,
  onSelectPage,
  onSelectAllLibrary,
  viewMode = "table",
  onViewModeChange,
}) {
  const t = useT();

  const viewBtn = (mode, Icon) => (
    <button
      type="button"
      title={mode === "grid" ? t("library.viewGrid") : t("library.viewList")}
      onClick={() => onViewModeChange?.(mode)}
      className={`p-1.5 rounded-md transition-all ${viewMode === mode ? "bg-cs2-accent text-cs2-text-on-accent shadow" : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-cs2-border pb-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-cs2-text-primary">{t("library.pageTitle")}</h1>
        <p className="mt-0.5 text-[12px] leading-relaxed text-cs2-text-muted">
          {t("library.pageSubtitle")}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        <div className="mr-1 flex items-center rounded-lg bg-cs2-bg-input/70 p-1 border border-cs2-border">
          {viewBtn("grid", LayoutGrid)}
          {viewBtn("list", List)}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-hover px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
          onClick={() => onOpenWatchPaths?.()}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-cs2-accent/90" aria-hidden />
          {t("library.btnWatchPaths")}
        </button>
        <button
          type="button"
          disabled={libraryLoading || libraryScanning}
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-accent/40 bg-cs2-accent/10 px-2.5 py-1.5 text-[12px] font-semibold text-cs2-accent hover:bg-cs2-accent/20 disabled:opacity-45"
          onClick={() => void onScan()}
        >
          {libraryScanning ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <ScanSearch className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          {libraryScanning ? t("library.btnScanning") : t("library.btnScan")}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-hover px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary disabled:opacity-45"
          onClick={() => onOpenIngest?.()}
        >
          <Database className="h-3.5 w-3.5 shrink-0 text-cs2-accent/90" aria-hidden />
          {t("library.btnPending")}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-hover px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
          onClick={() => void onOpenLocalDemo?.()}
          title={t("library.btnOpenLocalHint")}
        >
          <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted" aria-hidden />
          {t("library.btnOpenLocal")}
        </button>
        <span className="mx-1 hidden h-5 w-px bg-cs2-border sm:block" aria-hidden />
        <button
          type="button"
          disabled={libraryLoading || pageSelectableCount === 0}
          className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          onClick={onSelectPage}
        >
          {t("library.btnSelectPage", { count: pageSelectableCount })}
        </button>
        <button
          type="button"
          disabled={libraryLoading || (libraryTotal != null && libraryTotal === 0)}
          className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onSelectAllLibrary()}
        >
          {t("library.btnSelectAll", { count: libraryTotal ?? 0 })}
        </button>
      </div>
    </div>
  );
}
