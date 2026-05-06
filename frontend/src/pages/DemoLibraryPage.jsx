import { useCallback, useMemo, useState } from "react";
import { useAppShell } from "../context/AppShellContext";
import DemoAdvancedFilters from "../components/demoLibrary/DemoAdvancedFilters";
import DemoBatchActionBar from "../components/demoLibrary/DemoBatchActionBar";
import DemoLibraryQueryBar from "../components/demoLibrary/DemoLibraryQueryBar";
import DemoLibraryToolbar from "../components/demoLibrary/DemoLibraryToolbar";
import DemoPagination from "../components/demoLibrary/DemoPagination";
import DemoTable from "../components/demoLibrary/DemoTable";
import {
  applyClientSideDemoFilters,
  filterByPathAndTags,
  sortDemoRows,
} from "../utils/demoLibraryDisplay";

const INITIAL_ADV_FILTERS = {
  mapName: "",
  status: "all",
  playerQuery: "",
  steamQuery: "",
  minKills: "",
  maxDeaths: "",
  minAssists: "",
  minKd: "",
  roundsMin: "",
  roundsMax: "",
  durationMin: "",
  durationMax: "",
  dateFrom: "",
  dateTo: "",
};

export default function DemoLibraryPage() {
  const s = useAppShell();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sortKey, setSortKey] = useState("library");
  const [sortDir, setSortDir] = useState("desc");
  const [expandedScoreboardIds, setExpandedScoreboardIds] = useState(() => new Set());

  const filteredRows = useMemo(() => {
    let rows = s.demoLibraryItems;
    rows = applyClientSideDemoFilters(rows, s.libraryAdvFilters);
    rows = filterByPathAndTags(rows, s.librarySearchQ);
    return sortDemoRows(rows, sortKey, sortDir);
  }, [s.demoLibraryItems, s.libraryAdvFilters, s.librarySearchQ, sortKey, sortDir]);

  const onColumnSort = useCallback((col) => {
    setSortKey((prevKey) => {
      if (prevKey !== col) {
        setSortDir(col === "filename" || col === "map" ? "asc" : "desc");
        return col;
      }
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return prevKey;
    });
  }, []);

  const handleSelectVisiblePage = useCallback(() => {
    s.setSelectedLibraryDemoIds((prev) => {
      const next = new Set(prev);
      for (const it of filteredRows) {
        next.add(it.id);
      }
      return next;
    });
  }, [filteredRows, s.setSelectedLibraryDemoIds]);

  const onToggleSelect = useCallback(
    (id) => {
      s.setSelectedLibraryDemoIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [s.setSelectedLibraryDemoIds]
  );

  const clearAllFilters = useCallback(() => {
    s.setLibrarySearchInput("");
    s.setLibrarySearchQ("");
    s.setLibraryAdvFilters({ ...INITIAL_ADV_FILTERS });
    setAdvancedOpen(false);
    s.setLibraryPage(1);
    void s.refreshDemoLibrary(1, { manageLoading: true, searchQ: "" });
  }, [s]);

  const hasQuickOrAdvancedFilters = useMemo(() => {
    return !!(s.librarySearchInput.trim() || s.hasLibraryAdvancedFilters);
  }, [s.librarySearchInput, s.hasLibraryAdvancedFilters]);

  const emptyMessage = useMemo(() => {
    if (s.libraryLoading) return null;
    if (s.demoLibraryItems.length > 0 && filteredRows.length === 0) {
      return "没有符合条件的 Demo，尝试清空筛选";
    }
    if (s.demoLibraryItems.length === 0) {
      if (hasQuickOrAdvancedFilters || s.librarySearchQ) {
        return "没有符合条件的 Demo，尝试清空筛选";
      }
      return "暂无 Demo，前往设置配置监听目录或手动导入";
    }
    return null;
  }, [
    s.libraryLoading,
    s.demoLibraryItems.length,
    filteredRows.length,
    hasQuickOrAdvancedFilters,
    s.librarySearchQ,
  ]);

  const handleBatchDelete = useCallback(() => {
    const ids = Array.from(s.selectedLibraryDemoIds);
    if (!ids.length) return;
    if (
      !window.confirm(`确定从库中删除选中的 ${ids.length} 条记录？不会删除磁盘上的 .dem 文件。`)
    ) {
      return;
    }
    void s.handleLibraryBatchDelete(ids);
  }, [s]);

  const onPageChange = useCallback(
    (page) => {
      s.setLibraryPage(page);
      void s.refreshDemoLibrary(page, { manageLoading: false });
    },
    [s]
  );

  const onRename = useCallback(
    (it) => {
      s.setLibraryRename({
        id: it.id,
        draft: (it.display_name && String(it.display_name).trim()) || "",
      });
    },
    [s]
  );

  const onDeleteRow = useCallback(
    (it) => {
      s.setLibraryDeletePrompt({
        id: it.id,
        label: (it.display_name && String(it.display_name).trim()) || it.filename || `#${it.id}`,
      });
    },
    [s]
  );

  const toggleScoreboardExpand = useCallback((id) => {
    setExpandedScoreboardIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden px-4 py-3 sm:px-5">
      <DemoLibraryToolbar
        onScan={() => void s.handleScanDemos()}
        libraryLoading={s.libraryLoading}
        libraryScanning={s.libraryScanning}
        pageSelectableCount={filteredRows.length}
        libraryTotal={s.libraryTotal}
        onSelectPage={handleSelectVisiblePage}
        onSelectAllLibrary={() => void s.selectAllLibraryDemos()}
      />

      <DemoLibraryQueryBar
        librarySearchInput={s.librarySearchInput}
        onSearchChange={s.setLibrarySearchInput}
        onSearchSubmit={() => s.handleLibrarySearchSubmit()}
        libraryAdvFilters={s.libraryAdvFilters}
        setLibraryAdvFilters={s.setLibraryAdvFilters}
        sortKey={sortKey}
        sortDir={sortDir}
        onSortKeyChange={setSortKey}
        onSortDirChange={setSortDir}
        advancedOpen={advancedOpen}
        onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
        onClearQuickFilters={clearAllFilters}
        hasQuickOrAdvancedFilters={hasQuickOrAdvancedFilters}
      />

      {advancedOpen ? (
        <DemoAdvancedFilters libraryAdvFilters={s.libraryAdvFilters} setLibraryAdvFilters={s.setLibraryAdvFilters} />
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-cs2-bg-card/80">
        <DemoTable
          rows={filteredRows}
          selectedIds={s.selectedLibraryDemoIds}
          onToggleSelect={onToggleSelect}
          sortKey={sortKey}
          sortDir={sortDir}
          onColumnSort={onColumnSort}
          libraryLoading={s.libraryLoading}
          emptyHint={emptyMessage}
          expandedScoreboardIds={expandedScoreboardIds}
          onToggleScoreboardExpand={toggleScoreboardExpand}
          highlightQuery={s.libraryAdvFilters.playerQuery ?? ""}
          steamHighlightQuery={s.libraryAdvFilters.steamQuery ?? ""}
          onRename={onRename}
          onLoadRow={(it) => void s.handleLoadDemoFromLibrary([it])}
          onDelete={onDeleteRow}
        />

        <div className="flex shrink-0 justify-end border-t border-white/[0.06] px-2 py-1.5">
          <DemoPagination
            libraryPage={s.libraryPage}
            libraryTotalPages={s.libraryTotalPages}
            libraryHasNextPage={s.libraryHasNextPage}
            libraryPageSize={s.libraryPageSize}
            onPageSizeChange={s.setLibraryPageSize}
            libraryJumpDraft={s.libraryJumpDraft}
            onPageChange={onPageChange}
            onJumpDraftChange={s.setLibraryJumpDraft}
            onJumpSubmit={s.handleLibraryPageJump}
          />
        </div>
      </section>

      <DemoBatchActionBar
        count={s.selectedLibraryDemoIds.size}
        onLoadSelected={() => void s.handleLoadSelectedLibraryDemos()}
        onOpenBatchModal={() => s.setLibraryBatchModalOpen(true)}
        onBatchDelete={handleBatchDelete}
        onClearSelection={s.clearLibrarySelection}
      />

      {s.libraryDeletePrompt ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="library-delete-title"
          onClick={() => s.setLibraryDeletePrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="library-delete-title" className="mb-2 text-xs font-semibold text-zinc-300">
              从 Demo 库删除
            </h4>
            <p className="mb-3 font-mono text-[11px] text-zinc-400">{s.libraryDeletePrompt.label}</p>
            <p className="mb-3 text-[10px] leading-relaxed text-cs2-text-secondary">
              仅移除本地库中的记录与解析缓存，不会删除磁盘上的 .dem 文件。请选择删除之后再次扫描时的行为：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-left text-[11px] leading-snug text-emerald-200/95 hover:bg-emerald-500/20"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "reimport")}
              >
                删除后再次扫描仍入库
                <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">
                  下次扫描会重新加入库中，入库时间为扫描时刻。
                </span>
              </button>
              <button
                type="button"
                className="rounded border border-white/15 px-3 py-2 text-left text-[11px] leading-snug text-zinc-300 hover:bg-white/[0.06]"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "skip")}
              >
                删除后再次扫描不再入库
                <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">
                  之后目录监听与手动扫描都会跳过该路径；仅改文件名或移动文件可视为新路径再入库。
                </span>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded border border-cs2-border px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                onClick={() => s.setLibraryDeletePrompt(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {s.libraryRename ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="library-rename-title"
          onClick={() => s.setLibraryRename(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="library-rename-title" className="mb-2 text-xs font-semibold text-zinc-300">
              Demo 展示名
            </h4>
            <p className="mb-2 text-[10px] leading-relaxed text-cs2-text-secondary">
              仅保存在本地库中，不修改磁盘上的 .dem 文件名。留空并保存则恢复为文件名显示。
            </p>
            <input
              type="text"
              className="mb-3 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-cs2-orange/50"
              value={s.libraryRename.draft}
              onChange={(e) => s.setLibraryRename((prev) => (prev ? { ...prev, draft: e.target.value } : null))}
              maxLength={512}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-cs2-border px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                onClick={() => s.setLibraryRename(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded border border-cs2-orange/50 bg-cs2-orange/15 px-2 py-1 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/25"
                onClick={() => void s.handleSaveLibraryRename()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
