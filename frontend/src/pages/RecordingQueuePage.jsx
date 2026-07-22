import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import API from "../api/api";
import { useAppShell } from "../context/AppShellContext";
import { useRecordingQueue } from "../stores/recordingQueueStore";
import { useT } from "../i18n/useT.js";
import {
  estimateQueueTotalSeconds,
  countPovSegments,
  uniqueDemoCount,
} from "../utils/recordingQueueDerive";
import RecordingStatsStrip from "../components/recordingQueue/RecordingStatsStrip";
import QueueWorkspaceRow from "../components/recordingQueue/QueueWorkspaceRow";
import QueueInspectorPanel from "../components/recordingQueue/QueueInspectorPanel";
import RecordingControlDock from "../components/recordingQueue/RecordingControlDock";
import RecordingQueueEmptyState from "../components/recordingQueue/RecordingQueueEmptyState";
import PageContainer from "../components/PageContainer";
import { Search } from "lucide-react";

export default function RecordingQueuePage() {
  const t = useT();
  const s = useAppShell();
  const globalPacing = useRecordingQueue((st) => st.globalPacing);
  const reorderQueue = useRecordingQueue((st) => st.reorderQueue);
  const queue = s.queue;

  const [selectedId, setSelectedId] = useState(null);
  const [dragSourceIndex, setDragSourceIndex] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

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
    () => estimateQueueTotalSeconds(queue, globalPacing),
    [queue, globalPacing]
  );
  const povN = useMemo(() => countPovSegments(queue), [queue]);
  const demoN = useMemo(() => uniqueDemoCount(queue), [queue]);

  const selectedItem = useMemo(
    () => (selectedId ? queue.find((q) => q.id === selectedId) ?? null : null),
    [queue, selectedId]
  );

  const filteredQueue = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return queue
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const clip = item.clipData || {};
        if (categoryFilter !== "all" && clip.category !== categoryFilter) return false;
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

  return (
    <PageContainer>
    <div className="flex min-h-0 flex-1 w-full flex-col gap-2 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-cs2-border pb-4">
        <div className="min-w-0 shrink">
          <h1 className="text-[18px] font-bold leading-tight text-cs2-text-primary">{t("queue.pageTitle")}</h1>
          <p className="mt-0.5 text-[12px] leading-relaxed text-cs2-text-muted">
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card lg:flex-row">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-cs2-border lg:border-r">
          <div className="shrink-0 border-b border-cs2-border px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 focus-within:border-cs2-accent/50">
                <Search className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("queue.searchPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                aria-label={t("queue.filterAriaLabel")}
                className="rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] text-cs2-text-secondary outline-none focus:border-cs2-accent/50"
              >
                <option value="all">{t("queue.filterAll")}</option>
                <option value="highlight">{t("queue.rowCatHighlight")}</option>
                <option value="fail">{t("queue.rowCatFail")}</option>
                <option value="meme_death">{t("queue.rowCatMemeDeath")}</option>
                <option value="compilation">{t("queue.rowCatCompilation")}</option>
              </select>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-cs2-text-muted">
                {t("queue.filterCount", { shown: filteredQueue.length, total: queue.length })}
              </span>
            </div>
            <p className="mt-1.5 text-[10px] text-cs2-text-muted">
              {filterActive ? t("queue.reorderFilterHint") : canReorder ? t("queue.reorderHint") : t("queue.workspaceHint")}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3">
            {queue.length === 0 ? (
              <RecordingQueueEmptyState />
            ) : filteredQueue.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center text-center">
                <Search className="h-6 w-6 text-cs2-text-muted/40" />
                <p className="mt-2 text-xs font-semibold text-cs2-text-secondary">{t("queue.filterEmptyTitle")}</p>
                <p className="mt-1 text-[10px] text-cs2-text-muted">{t("queue.filterEmptyHint")}</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {filteredQueue.map(({ item: it, index: i }) => (
                  <li
                    key={it.id}
                    className={[
                      "rounded-lg transition-[opacity,box-shadow]",
                      dropTargetIndex === i &&
                        dragSourceIndex !== null &&
                        dragSourceIndex !== i
                        ? "ring-2 ring-cs2-accent/45 ring-offset-2 ring-offset-cs2-bg-page"
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

        <aside className="flex min-h-0 w-full max-h-[min(50vh,420px)] shrink-0 flex-col border-cs2-border bg-cs2-bg-card lg:max-h-none lg:min-h-0 lg:w-[min(100%,340px)] lg:shrink-0 lg:self-stretch lg:border-l lg:border-t-0">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <QueueInspectorPanel
              selectedId={selectedId}
              selectedItem={selectedItem}
              queue={queue}
            />
          </div>
        </aside>
      </div>

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
  );
}
