import { Database, FolderOpen, LayoutGrid, List, Loader2 } from "lucide-react";

export default function DemoLibraryToolbar({
  onOpenWatchPaths,
  onScan,
  onOpenIngest,
  libraryLoading,
  libraryScanning,
  pageSelectableCount,
  libraryTotal,
  onSelectPage,
  onSelectAllLibrary,
  viewMode = "table",
  onViewModeChange,
}) {
  const viewBtn = (mode, Icon) => (
    <button
      type="button"
      title={mode === "grid" ? "网格视图" : mode === "list" ? "列表视图" : "表格视图"}
      onClick={() => onViewModeChange?.(mode)}
      className={`p-1.5 rounded-md transition-all ${viewMode === mode ? "bg-cs2-orange text-black shadow" : "text-zinc-600 hover:text-zinc-300"}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-white/[0.06] pb-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-white">本地 Demo 库</h1>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
          主库仅展示已入库 Demo；新文件在「待入库」中批量入库后再在此管理、解析高光。
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        <div className="mr-1 flex items-center rounded-lg bg-black/40 p-1 border border-white/5">
          {viewBtn("grid", LayoutGrid)}
          {viewBtn("list", List)}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 hover:border-cs2-orange/35 hover:text-white"
          onClick={() => onOpenWatchPaths?.()}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-cs2-orange/90" aria-hidden />
          监听目录
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-cs2-orange/40 bg-cs2-orange/10 px-2.5 py-1.5 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/20"
          onClick={() => onOpenIngest?.()}
        >
          <Database className="h-3.5 w-3.5 shrink-0" aria-hidden />
          待入库
        </button>
        <button
          type="button"
          disabled={libraryLoading || libraryScanning}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 hover:border-cs2-orange/35 hover:text-white disabled:opacity-45"
          onClick={() => void onScan()}
        >
          {libraryScanning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cs2-orange" aria-hidden />
              <span>扫描中…</span>
            </>
          ) : (
            "扫描本地 demo 库"
          )}
        </button>
        <button
          type="button"
          disabled={libraryLoading || pageSelectableCount === 0}
          className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-400 hover:border-cs2-orange/35 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
          onClick={onSelectPage}
        >
          本页全选
        </button>
        <button
          type="button"
          disabled={libraryLoading || (libraryTotal != null && libraryTotal === 0)}
          className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-400 hover:border-cs2-orange/35 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => void onSelectAllLibrary()}
        >
          全选库内
        </button>
      </div>
    </div>
  );
}
