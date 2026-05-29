import { useCallback, useMemo, useState } from "react";
import API from "../api/api";
import { LayoutGrid, List } from "lucide-react";
import PageContainer from "../components/PageContainer";
import { useAppShell } from "../context/AppShellContext";
import { useRecordingQueue } from "../stores/recordingQueueStore";
import DemoAdvancedFilters from "../components/demoLibrary/DemoAdvancedFilters";
import DemoBatchActionBar from "../components/demoLibrary/DemoBatchActionBar";
import DemoLibraryQueryBar from "../components/demoLibrary/DemoLibraryQueryBar";
import DemoLibraryToolbar from "../components/demoLibrary/DemoLibraryToolbar";
import DemoWatchPathsModal from "../components/demoLibrary/DemoWatchPathsModal";
import DemoPagination from "../components/demoLibrary/DemoPagination";
import MatchCard, { MatchListRow } from "../components/MatchCard";
import DemoInfoModal from "../components/DemoInfoModal";
import IngestModal from "../components/IngestModal";
import {
  applyClientSideDemoFilters,
  filterByPathAndTags,
  sortDemoRows,
} from "../utils/demoLibraryDisplay";
import { exportRivalHubBatch } from "../utils/rivalHubExport";
import RivalHubExportToast from "../components/demoLibrary/RivalHubExportToast";

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
  const addToQueue = useRecordingQueue((st) => st.addToQueue);
  const queue = useRecordingQueue((st) => st.queue);

  const [viewMode, setViewMode] = useState("grid"); // "grid" | "list"
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sortKey, setSortKey] = useState("library");
  const [sortDir, setSortDir] = useState("desc");
  const [watchPathsModalOpen, setWatchPathsModalOpen] = useState(false);
  const [demoInfoModalId, setDemoInfoModalId] = useState(null);
  const [ingestModalOpen, setIngestModalOpen] = useState(false);

  // rivalHubToasts: { id: number, label: string, phase: string, blob?: Blob, filename?: string, error?: string }[]
  const [rivalHubToasts, setRivalHubToasts] = useState([]);

  const queuedClientClipUids = useMemo(
    () => new Set(queue.map((q) => q.clientClipUid).filter(Boolean)),
    [queue]
  );

  const expectedPlayers = useMemo(() => {
    const raw = s.expectedParsePlayersText || "";
    return raw.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  }, [s.expectedParsePlayersText]);

  const handleAddToQueue = useCallback((clips) => {
    if (!clips?.length) return;
    addToQueue(clips);
  }, [addToQueue]);

  const handleBatchIngest = useCallback(async (ids) => {
    await API.post("/demos/batch-ingest", { demo_ids: ids });
    void s.refreshDemoLibrary(s.libraryPage, { manageLoading: false });
  }, [s]);

  const handleUpdateRemark = useCallback(async (demoId, remark) => {
    try {
      await API.patch(`/demos/${demoId}/remark`, { remark: remark || "" });
      void s.refreshDemoLibrary(s.libraryPage, { manageLoading: false });
    } catch (e) {
      console.error("Update remark failed", e);
    }
  }, [s]);

  const handleCardPlay = useCallback((demoId) => {
    const item = s.demoLibraryItems.find((it) => it.id === demoId);
    if (item) void s.handleLoadDemoFromLibrary([item]);
  }, [s]);

  const handleOpenFile = useCallback(
    async (demoId) => {
      const row = s.demoLibraryItems.find((it) => it.id === demoId);
      let p = row?.path;
      if (!p || typeof p !== "string" || !String(p).trim()) {
        try {
          const { data } = await API.get(`/demos/${demoId}`);
          p = data?.path;
        } catch {
          p = null;
        }
      }
      if (!p || typeof p !== "string" || !String(p).trim()) {
        s.setProgressText("无法获取该 Demo 的磁盘路径。");
        return;
      }
      try {
        await API.post("/reveal-file-in-explorer", { path: String(p).trim() });
      } catch (e) {
        const d = e?.response?.data?.detail;
        const msg = Array.isArray(d)
          ? d.map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x))).join("；")
          : typeof d === "string"
            ? d
            : e?.message || "定位失败";
        s.setProgressText(`在资源管理器中打开失败: ${msg}`);
      }
    },
    [s],
  );

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
      return "暂无 Demo，点击「监听目录」添加路径或手动导入";
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

  const handleExportRivalHub = useCallback(() => {
    const selectedIds = Array.from(s.selectedLibraryDemoIds);
    const doneItems = selectedIds
      .map((id) => s.demoLibraryItems.find((it) => it.id === id))
      .filter((it) => it && it.result);

    const skipped = selectedIds.length - doneItems.length;
    if (skipped > 0) {
      s.setProgressText(`${skipped} 个未解析的 Demo 已跳过导出。`);
    }
    if (!doneItems.length) return;

    // initialize toasts
    setRivalHubToasts((prev) => [
      ...prev,
      ...doneItems.map((it) => ({
        id: it.id,
        label:
          (it.display_name && String(it.display_name).trim()) ||
          it.filename ||
          `Demo #${it.id}`,
        phase: "loading",
      })),
    ]);

    const ids = doneItems.map((it) => it.id);
    void exportRivalHubBatch(ids, (demoId, status) => {
      setRivalHubToasts((prev) =>
        prev.map((t) => (t.id === demoId ? { ...t, ...status } : t))
      );
    });
  }, [s]);

  const handleCloseToast = useCallback((id) => {
    setRivalHubToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <PageContainer className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden">
      <DemoLibraryToolbar
        onOpenWatchPaths={() => setWatchPathsModalOpen(true)}
        onScan={() => void s.handleScanDemos()}
        onOpenIngest={() => setIngestModalOpen(true)}
        libraryLoading={s.libraryLoading}
        libraryScanning={s.libraryScanning}
        pageSelectableCount={filteredRows.length}
        libraryTotal={s.libraryTotal}
        onSelectPage={handleSelectVisiblePage}
        onSelectAllLibrary={() => void s.selectAllLibraryDemos()}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
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

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
          {s.libraryLoading ? (
            <div className="flex h-32 items-center justify-center text-cs2-text-muted text-sm">加载中...</div>
          ) : filteredRows.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-cs2-text-muted text-sm">{emptyMessage || "暂无 Demo"}</div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredRows.map((it) => (
                <MatchCard
                  key={it.id}
                  demo={it}
                  isSelected={s.selectedLibraryDemoIds.has(it.id)}
                  onSelect={(id, checked) => {
                    s.setSelectedLibraryDemoIds((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(id); else next.delete(id);
                      return next;
                    });
                  }}
                  onPlay={handleCardPlay}
                  onOpenFile={handleOpenFile}
                  onDelete={(id, filename) => s.setLibraryDeletePrompt({ id, label: filename || `#${id}` })}
                  onUpdateRemark={handleUpdateRemark}
                  onOpenInfo={(id) => setDemoInfoModalId(id)}
                  expectedPlayers={expectedPlayers}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredRows.map((it) => (
                <MatchListRow
                  key={it.id}
                  demo={it}
                  isSelected={s.selectedLibraryDemoIds.has(it.id)}
                  onSelect={(id, checked) => {
                    s.setSelectedLibraryDemoIds((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(id); else next.delete(id);
                      return next;
                    });
                  }}
                  onPlay={handleCardPlay}
                  onOpenFile={handleOpenFile}
                  onDelete={(id, filename) => s.setLibraryDeletePrompt({ id, label: filename || `#${id}` })}
                  onUpdateRemark={handleUpdateRemark}
                  onOpenInfo={(id) => setDemoInfoModalId(id)}
                  expectedPlayers={expectedPlayers}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-cs2-border px-2 py-1.5">
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
        onExportRivalHub={handleExportRivalHub}
      />

      {s.libraryDeletePrompt ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-cs2-bg-page/85 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="library-delete-title"
          onClick={() => s.setLibraryDeletePrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-cs2-border bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="library-delete-title" className="mb-2 text-xs font-semibold text-cs2-text-secondary">
              从 Demo 库删除
            </h4>
            <p className="mb-3 font-mono text-[12px] text-cs2-text-secondary">{s.libraryDeletePrompt.label}</p>
            <p className="mb-3 text-[11px] leading-relaxed text-cs2-text-secondary">
              仅移除本地库中的记录与解析缓存，不会删除磁盘上的 .dem 文件。请选择删除之后再次扫描时的行为：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-left text-[11px] leading-snug text-cs2-emerald-on-surface hover:bg-emerald-500/20"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "reimport")}
              >
                删除后再次扫描仍入库
                <span className="mt-0.5 block text-[11px] font-normal text-cs2-text-muted">
                  下次扫描会重新加入库中，入库时间为扫描时刻。
                </span>
              </button>
              <button
                type="button"
                className="rounded border border-cs2-border px-3 py-2 text-left text-[11px] leading-snug text-cs2-text-secondary hover:bg-cs2-bg-input/50"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "skip")}
              >
                删除后再次扫描不再入库
                <span className="mt-0.5 block text-[11px] font-normal text-cs2-text-muted">
                  之后目录监听与手动扫描都会跳过该路径；仅改文件名或移动文件可视为新路径再入库。
                </span>
              </button>
              <button
                type="button"
                className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-left text-[11px] leading-snug text-red-400 hover:bg-red-500/20"
                onClick={() => {
                  const p = s.libraryDeletePrompt;
                  const row = s.demoLibraryItems.find((it) => it.id === p.id);
                  const base = (row?.filename || p.label || "").replace(/\.\w+$/, "");
                  const files = [`${base}.dem`, `${base}.zip`];
                  if (window.confirm(`确定要删除以下文件？\n\n${files.join("\n")}\n\n此操作不可恢复。`)) {
                    void s.handleDeleteDemoFile(p.id);
                  }
                }}
              >
                从磁盘删除文件
                <span className="mt-0.5 block text-[11px] font-normal text-red-300/60">
                  永久删除 .dem 及同名 .zip 文件，不可恢复。
                </span>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded border border-cs2-border px-2 py-1 text-[11px] text-cs2-text-secondary hover:text-cs2-text-primary"
                onClick={() => s.setLibraryDeletePrompt(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DemoWatchPathsModal
        open={watchPathsModalOpen}
        onClose={() => setWatchPathsModalOpen(false)}
        demoWatchPaths={s.demoWatchPaths}
        onDemoWatchPathsChange={s.setDemoWatchPaths}
        onSaveConfig={s.handleSaveConfig}
      />

      {s.libraryRename ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-cs2-bg-page/85 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="library-rename-title"
          onClick={() => s.setLibraryRename(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-cs2-border bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="library-rename-title" className="mb-2 text-xs font-semibold text-cs2-text-secondary">
              Demo 展示名
            </h4>
            <p className="mb-2 text-[11px] leading-relaxed text-cs2-text-secondary">
              仅保存在本地库中，不修改磁盘上的 .dem 文件名。留空并保存则恢复为文件名显示。
            </p>
            <input
              type="text"
              className="mb-3 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] text-cs2-text-primary outline-none focus:border-cs2-accent/50"
              value={s.libraryRename.draft}
              onChange={(e) => s.setLibraryRename((prev) => (prev ? { ...prev, draft: e.target.value } : null))}
              maxLength={512}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-cs2-border px-2 py-1 text-[11px] text-cs2-text-secondary hover:text-cs2-text-primary"
                onClick={() => s.setLibraryRename(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded border border-cs2-accent/50 bg-cs2-accent/15 px-2 py-1 text-[11px] font-semibold text-cs2-accent hover:bg-cs2-accent/25"
                onClick={() => void s.handleSaveLibraryRename()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DemoInfoModal
        open={demoInfoModalId !== null}
        onClose={() => setDemoInfoModalId(null)}
        demoId={demoInfoModalId}
        onAddToQueue={handleAddToQueue}
        expectedPlayers={expectedPlayers}
        aiMode={s.aiMode}
        queuedClientClipUids={queuedClientClipUids}
      />

      <IngestModal
        isOpen={ingestModalOpen}
        onClose={() => setIngestModalOpen(false)}
        onIngest={handleBatchIngest}
        onUpload={s.handleUpload}
      />
      {rivalHubToasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {rivalHubToasts.map((t) => (
            <RivalHubExportToast
              key={t.id}
              id={t.id}
              label={t.label}
              phase={t.phase}
              blob={t.blob}
              filename={t.filename}
              error={t.error}
              onClose={handleCloseToast}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
