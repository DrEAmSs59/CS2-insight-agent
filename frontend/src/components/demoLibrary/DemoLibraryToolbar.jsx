import { Loader2 } from "lucide-react";

export default function DemoLibraryToolbar({
  onScan,
  libraryLoading,
  libraryScanning,
  pageSelectableCount,
  libraryTotal,
  onSelectPage,
  onSelectAllLibrary,
}) {
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-white/[0.06] pb-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-white">本地 Demo 库</h1>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
          表格批量管理本地入库的 Demo；监听与扫描在「设置」。
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
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
