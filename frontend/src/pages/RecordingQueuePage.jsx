import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import API from "../api/api";
import { useAppShell } from "../context/AppShellContext";
import { useRecordingQueue } from "../stores/recordingQueueStore";
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

export default function RecordingQueuePage() {
  const s = useAppShell();
  const globalPacing = useRecordingQueue((st) => st.globalPacing);
  const reorderQueue = useRecordingQueue((st) => st.reorderQueue);
  const queue = s.queue;

  const [selectedId, setSelectedId] = useState(null);
  const [dragSourceIndex, setDragSourceIndex] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);

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

  const queueStatusLabel = s.batchRecording
    ? "录制中"
    : queue.length > 0
      ? "待开始"
      : "已完成";
  const obsEndpointLabel = `${s.obsConfig?.host || "localhost"}:${s.obsConfig?.port ?? 4455}`;

  const canReorder = queue.length > 1 && !s.batchRecording;

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
          <h1 className="text-[18px] font-bold leading-tight text-cs2-text-primary">录制控制中心</h1>
          <p className="mt-0.5 text-[12px] leading-relaxed text-cs2-text-muted">
            待输出至 OBS 的素材批次；按分组顺序回放与导出。
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
          <div className="shrink-0 border-b border-cs2-border px-4 py-3 sm:px-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-cs2-text-muted">
              队列工作区
            </h2>
            {canReorder ? (
              <p className="mt-0.5 text-[10px] text-cs2-text-muted">按住左侧 ⋮⋮ 手柄拖动可调整顺序（与导出顺序一致）</p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3">
            {queue.length === 0 ? (
              <RecordingQueueEmptyState />
            ) : (
              <ul className="space-y-2">
                {queue.map((it, i) => (
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
        onClear={handleClear}
        disabledStart={queue.length === 0 || s.batchRecording}
        obsConfigured={obsConfigured}
      />
    </div>
    </PageContainer>
  );
}
