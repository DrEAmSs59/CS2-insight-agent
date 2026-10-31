import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import API from "../api/api";
import { useAppShell } from "../context/AppShellContext";
import { useRecordingQueue } from "../stores/recordingQueueStore";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import LucasWorkshopBackground from "../features/cosmetics-workshop/LucasWorkshopBackground.jsx";
import "../features/cosmetics-workshop/lucasWorkshop.css";
import {
  estimateQueueTotalSeconds,
  countPovSegments,
  uniqueDemoCount,
} from "../utils/recordingQueueDerive";
import RecordingStatsStrip from "../components/recordingQueue/RecordingStatsStrip";
import QueueWorkspaceRow from "../components/recordingQueue/QueueWorkspaceRow";
import QueueInspectorPanel from "../components/recordingQueue/QueueInspectorPanel";
import QueueGlobalPacingPanel, { QueueDefaultsSummary } from "../components/recordingQueue/QueueGlobalPacingPanel";
import RecordingControlDock from "../components/recordingQueue/RecordingControlDock";
import RecordingQueueEmptyState from "../components/recordingQueue/RecordingQueueEmptyState";
import PageContainer from "../components/PageContainer";
import { Search } from "lucide-react";
import { Segmented } from "./settings/SettingsControls.jsx";
import { isTimelineSourceClip } from "../utils/montageUtils";
import { RoundCompilationPlansContext, useRoundCompilationPlans } from "../recording/useRoundCompilationPlans";

const FILTER_LABELS = {
  all: "queue.filterAllShort",
  highlight: "queue.rowCatHighlight",
  fail: "queue.rowCatFail",
  meme_death: "queue.rowCatMemeDeath",
  compilation: "queue.rowCatCompilation",
  timeline: "queue.rowCatTimeline",
};

/** Filter bucket for a clip; timeline clips get their own bucket regardless of category. */
function queueFilterKey(clip) {
  if (isTimelineSourceClip(clip)) return "timeline";
  return clip?.category || "other";
}

export default function RecordingQueuePage() {
  const t = useT();
  const locale = useLocaleStore((state) => state.effectiveLocale);
  const s = useAppShell();
  const globalPacing = useRecordingQueue((st) => st.globalPacing);
  const reorderQueue = useRecordingQueue((st) => st.reorderQueue);
  const queue = s.queue;
  const roundPlans = useRoundCompilationPlans(queue, globalPacing, s.uploadedDemos, s.parsedMatches, s.demoLibraryItems);

  const [selectedId, setSelectedId] = useState(null);
  const [dragSourceIndex, setDragSourceIndex] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  // OBS 配置状态：与首页 /api/config/quick-check 一致，后端判断 host + password + port > 0
  const [obsConfigured, setObsConfigured] = useState(false);
  const [obsConfigHasIssues, setObsConfigHasIssues] = useState(/** @type {boolean | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    API.get("/config/quick-check").then(({ data }) => {
      if (cancelled) return;
      setObsConfigured(!!data?.obs_configured);
    }).catch(() => {
      if (cancelled) return;
      setObsConfigured(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (queue.length === 0) {
      setSelectedId(null);
      return;
    }
    const stillThere = selectedId && queue.some((q) => q.id === selectedId);
    if (!stillThere) {
      setSelectedId(queue[0].id);
    }
  }, [queue, selectedId]);

  const handleClear = () => {
    s.clearQueue();
    setSelectedId(null);
  };

  const totalEstimateSec = useMemo(
    () => estimateQueueTotalSeconds(queue, globalPacing, roundPlans),
    [queue, globalPacing, roundPlans]
  );
  const povN = useMemo(() => countPovSegments(queue), [queue]);
  const demoN = useMemo(() => uniqueDemoCount(queue), [queue]);

  const selectedItem = useMemo(
    () => (selectedId ? queue.find((q) => q.id === selectedId) ?? null : null),
    [queue, selectedId]
  );

  const filterOptions = useMemo(() => {
    const counts = { all: queue.length };
    for (const item of queue) {
      const key = queueFilterKey(item.clipData || {});
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.keys(FILTER_LABELS)
      .filter((key) => key === "all" || counts[key] > 0 || key === categoryFilter)
      .map((key) => ({
        value: key,
        label: (
          <>
            {t(FILTER_LABELS[key])}
            <span className="font-mono text-[10.5px] text-cs2-text-muted">{counts[key] || 0}</span>
          </>
        ),
      }));
  }, [queue, categoryFilter, t]);

  const filteredQueue = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return queue
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const clip = item.clipData || {};
        if (categoryFilter !== "all" && queueFilterKey(clip) !== categoryFilter) return false;
        if (!needle) return true;
        const searchable = [
          item.demoFilename,
          item.demoPath,
          item.targetPlayer,
          clip.player_name,
          clip.map_name,
          clip.map,
          clip.queue_summary_line,
          clip.category,
          ...(Array.isArray(clip.context_tags) ? clip.context_tags : []),
        ].filter(Boolean).join(" ").toLocaleLowerCase();
        return searchable.includes(needle);
      });
  }, [queue, query, categoryFilter]);

  const queueStatusLabel = s.batchRecording
    ? t("queue.statusRecording")
    : queue.length > 0
      ? t("queue.statusPending")
      : t("queue.statusDone");
  const obsEndpointLabel = `${s.obsConfig?.host || "localhost"}:${s.obsConfig?.port ?? 4455}`;

  const filterActive = Boolean(query.trim()) || categoryFilter !== "all";
  const canReorder = queue.length > 1 && !s.batchRecording && !filterActive;

  const handleReorderDragStart = useCallback((index) => {
    setDragSourceIndex(index);
  }, []);

  const handleReorderDragEnd = useCallback(() => {
    setDragSourceIndex(null);
    setDropTargetIndex(null);
  }, []);

  const handleLiDragOver = useCallback((e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (e.dataTransfer.types?.includes?.("text/plain")) {
      setDropTargetIndex(index);
    }
  }, []);

  const handleLiDragLeave = useCallback((e) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setDropTargetIndex(null);
  }, []);

  const handleLiDrop = useCallback(
    (e, toIndex) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("text/plain");
      const from = parseInt(raw, 10);
      if (Number.isFinite(from)) reorderQueue(from, toIndex);
      setDragSourceIndex(null);
      setDropTargetIndex(null);
    },
    [reorderQueue]
  );

  const visibleIndex = filteredQueue.findIndex(({ item }) => item.id === selectedId);
  const selectRelative = (offset) => {
    const next = filteredQueue[visibleIndex + offset];
    if (next) setSelectedId(next.item.id);
  };

  return (
    <RoundCompilationPlansContext.Provider value={roundPlans}>
    <div className="lucas-page-backdrop h-full min-h-0 w-full bg-cs2-bg-page">
    <LucasWorkshopBackground locale={locale} />
    <PageContainer>
    <div className="flex min-h-0 flex-1 w-full flex-col gap-3 overflow-hidden">
      <div
        data-testid="recording-queue-page-header"
        className="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-lg border border-cs2-border-subtle bg-cs2-bg-card/90 backdrop-blur-md px-4 py-3"
      >
        <div className="min-w-0 shrink">
          <h1 className="text-xl font-bold leading-tight text-cs2-text-primary">{t("queue.pageTitle")}</h1>
          <p className="mt-1 text-[12.5px] text-cs2-text-muted">
            {t("queue.pageSubtitle")}
          </p>
        </div>
        <RecordingStatsStrip
          pendingCount={queue.length}
          totalEstimateSec={totalEstimateSec}
          povSegmentCount={povN}
          demoCount={demoN}
          queueStatusLabel={queueStatusLabel}
          obsConfigured={obsConfigured}
          obsEndpointLabel={obsEndpointLabel}
          obsConfigHasIssues={obsConfigHasIssues}
        />
      </div>

      {queue.length > 0 ? (
        <div data-testid="recording-queue-search-card" className="flex shrink-0 flex-wrap items-center gap-2.5 rounded-lg border border-cs2-border-subtle bg-cs2-bg-card/90 backdrop-blur-md p-2.5">
          <label className="relative block w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("queue.searchPlaceholder")}
              aria-label={t("queue.searchPlaceholder")}
              className="h-8 w-full rounded-md border border-cs2-border-subtle bg-cs2-bg-card pl-8 pr-2.5 text-xs text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent"
            />
          </label>
          <Segmented
            ariaLabel={t("queue.filterAriaLabel")}
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={filterOptions}
          />
          <div className="ml-auto">
            <QueueDefaultsSummary open={defaultsOpen} onToggle={() => setDefaultsOpen((open) => !open)} />
          </div>
        </div>
      ) : null}

      {defaultsOpen && queue.length > 0 ? (
        <QueueGlobalPacingPanel queue={queue} onClose={() => setDefaultsOpen(false)} />
      ) : null}

      {queue.length === 0 ? (
        <section data-testid="recording-queue-list-card" className="min-h-0 flex-1 overflow-y-auto">
          <RecordingQueueEmptyState />
        </section>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
          <section
            data-testid="recording-queue-list-card"
            aria-label={t("queue.listTitle")}
            className="flex max-h-[45vh] min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card lg:max-h-none lg:w-[400px]"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-cs2-border-subtle px-3.5 py-2.5 text-xs text-cs2-text-muted">
              <span className="min-w-0 truncate">
                {filterActive ? t("queue.reorderFilterHint") : canReorder ? t("queue.reorderHintShort") : t("queue.listTitle")}
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {t("queue.filterCount", { shown: filteredQueue.length, total: queue.length })}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {filteredQueue.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center text-center">
                  <Search className="h-6 w-6 text-cs2-text-muted/40" />
                  <p className="mt-2 text-xs font-semibold text-cs2-text-secondary">{t("queue.filterEmptyTitle")}</p>
                  <p className="mt-1 text-[11px] text-cs2-text-muted">{t("queue.filterEmptyHint")}</p>
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {filteredQueue.map(({ item: it, index: i }) => (
                    <li
                      key={it.id}
                      className={[
                        "rounded-lg transition-[opacity,box-shadow]",
                        dropTargetIndex === i &&
                          dragSourceIndex !== null &&
                          dragSourceIndex !== i
                          ? "ring-2 ring-cs2-accent/45"
                          : "",
                        dragSourceIndex === i ? "opacity-60" : "",
                      ].join(" ")}
                      onDragOver={canReorder ? (e) => handleLiDragOver(e, i) : undefined}
                      onDragLeave={canReorder ? handleLiDragLeave : undefined}
                      onDrop={canReorder ? (e) => handleLiDrop(e, i) : undefined}
                    >
                      <QueueWorkspaceRow
                        item={it}
                        priorityIndex={i + 1}
                        queueIndex={i}
                        dragReorderEnabled={canReorder}
                        onReorderDragStart={() => handleReorderDragStart(i)}
                        onReorderDragEnd={handleReorderDragEnd}
                        selected={selectedId === it.id}
                        onSelect={() => setSelectedId(it.id)}
                        onRemove={() => s.removeFromQueue(it.id)}
                        globalPacing={globalPacing}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section
            data-testid="recording-queue-inspector-card"
            aria-label={t("queue.editorTitle")}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card"
          >
            <QueueInspectorPanel
              selectedItem={selectedItem}
              disabled={s.batchRecording}
              hasPrev={visibleIndex > 0}
              hasNext={visibleIndex >= 0 && visibleIndex < filteredQueue.length - 1}
              onPrev={() => selectRelative(-1)}
              onNext={() => selectRelative(1)}
              onRemove={() => selectedItem && s.removeFromQueue(selectedItem.id)}
            />
          </section>
        </div>
      )}

      <RecordingControlDock
        queueLength={queue.length}
        totalEstimateSec={totalEstimateSec}
        batchRecording={s.batchRecording}
        onStart={s.openBatchWarmup}
        onAbort={s.handleAbortBatchRecording}
        abortRequested={s.recordingAbortRequested}
        onClear={handleClear}
        disabledStart={queue.length === 0 || s.batchRecording}
        obsConfigured={obsConfigured}
      />
    </div>
    </PageContainer>
    </div>
    </RoundCompilationPlansContext.Provider>
  );
}
