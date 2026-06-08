import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API from "../api/api";
import { LayoutGrid, List, AlertCircle, X, Play } from "lucide-react";
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
import { useT } from "../i18n/useT.js";

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
  const t = useT();
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

  const [playToast, setPlayToast] = useState(null); // { ok: bool, label: string } | null
  const playToastTimer = useRef(null);

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

  const showPlayToast = useCallback((ok, label) => {
    clearTimeout(playToastTimer.current);
    setPlayToast({ ok, label });
    playToastTimer.current = setTimeout(() => setPlayToast(null), 4000);
  }, []);

  useEffect(() => () => clearTimeout(playToastTimer.current), []);

  const handleCardPlay = useCallback(async (demoId) => {
    const item = s.demoLibraryItems.find((it) => it.id === demoId);
    const label = (item?.display_name && String(item.display_name).trim()) || item?.filename || `#${demoId}`;
    try {
      await API.post(`/demos/${demoId}/play`);
      showPlayToast(true, label);
    } catch (e) {
      showPlayToast(false, e.response?.data?.detail || e.message);
    }
  }, [s, showPlayToast]);

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
        s.setProgressText(t("library.openFileError"));
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
            : e?.message || t("library.actionDelete");
        s.setProgressText(t("library.openFileFailPrefix", { msg }));
      }
    },
    [s, t],
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
      return t("library.emptyNoMatch");
    }
    if (s.demoLibraryItems.length === 0) {
      if (hasQuickOrAdvancedFilters || s.librarySearchQ) {
        return t("library.emptyNoMatch");
      }
      return t("library.emptyNoDemo");
    }
    return null;
  }, [
    s.libraryLoading,
    s.demoLibraryItems.length,
    filteredRows.length,
    hasQuickOrAdvancedFilters,
    s.librarySearchQ,
    t,
  ]);

  const handleBatchDelete = useCallback(() => {
    const ids = Array.from(s.selectedLibraryDemoIds);
    if (!ids.length) return;
    if (
      !window.confirm(t("library.batchDeleteConfirm", { count: ids.length }))
    ) {
      return;
    }
    void s.handleLibraryBatchDelete(ids);
  }, [s, t]);

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
            <div className="flex h-32 items-center justify-center text-cs2-text-muted text-sm">{t("library.loading")}</div>
          ) : filteredRows.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-cs2-text-muted text-sm">{emptyMessage || t("library.noDemo")}</div>
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
              {t("library.deleteTitle")}
            </h4>
            <p className="mb-3 font-mono text-[12px] text-cs2-text-secondary">{s.libraryDeletePrompt.label}</p>
            <p className="mb-3 text-[11px] leading-relaxed text-cs2-text-secondary">
              {t("library.deleteDesc")}
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-left text-[11px] leading-snug text-cs2-emerald-on-surface hover:bg-emerald-500/20"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "reimport")}
              >
                {t("library.deleteReimport")}
                <span className="mt-0.5 block text-[11px] font-normal text-cs2-text-muted">
                  {t("library.deleteReimportHint")}
                </span>
              </button>
              <button
                type="button"
                className="rounded border border-cs2-border px-3 py-2 text-left text-[11px] leading-snug text-cs2-text-secondary hover:bg-cs2-bg-input/50"
                onClick={() => void s.handleDeleteDemo(s.libraryDeletePrompt.id, "skip")}
              >
                {t("library.deleteSkip")}
                <span className="mt-0.5 block text-[11px] font-normal text-cs2-text-muted">
                  {t("library.deleteSkipHint")}
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
                  if (window.confirm(t("library.deleteDiskConfirm", { files: files.join("\n") }))) {
                    void s.handleDeleteDemoFile(p.id);
                  }
                }}
              >
                {t("library.deleteDisk")}
                <span className="mt-0.5 block text-[11px] font-normal text-red-300/60">
                  {t("library.deleteDiskHint")}
                </span>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded border border-cs2-border px-2 py-1 text-[11px] text-cs2-text-secondary hover:text-cs2-text-primary"
                onClick={() => s.setLibraryDeletePrompt(null)}
              >
                {t("library.deleteCancel")}
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

      {playToast && (
        <div className="fixed bottom-6 right-6 z-[200] flex items-start gap-3 rounded-lg border bg-cs2-bg-card px-4 py-3 shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200"
          style={{ borderColor: playToast.ok ? "rgb(52 211 153 / 0.4)" : "rgb(248 113 113 / 0.4)" }}
        >
          <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${playToast.ok ? "bg-cs2-emerald-surface text-cs2-emerald-on-surface" : "bg-cs2-red-surface text-cs2-red-on-surface"}`}>
            {playToast.ok ? <Play className="h-3 w-3 fill-current" /> : <AlertCircle className="h-3 w-3" />}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={`text-[12px] font-semibold ${playToast.ok ? "text-cs2-emerald-on-surface" : "text-cs2-red-on-surface"}`}>
              {playToast.ok ? t("library.playToastOk") : t("library.playToastFail")}
            </span>
            <span className="max-w-[260px] truncate font-mono text-[11px] text-cs2-text-muted" title={playToast.label}>
              {playToast.label}
            </span>
          </div>
          <button
            type="button"
            className="ml-2 mt-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
            onClick={() => setPlayToast(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
              {t("library.renameTitle")}
            </h4>
            <p className="mb-2 text-[11px] leading-relaxed text-cs2-text-secondary">
              {t("library.renameDesc")}
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
                {t("library.renameCancel")}
              </button>
              <button
                type="button"
                className="rounded border border-cs2-accent/50 bg-cs2-accent/15 px-2 py-1 text-[11px] font-semibold text-cs2-accent hover:bg-cs2-accent/25"
                onClick={() => void s.handleSaveLibraryRename()}
              >
                {t("library.renameSave")}
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
    </PageContainer>
  );
}
