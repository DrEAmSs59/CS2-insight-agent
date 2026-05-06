import { useState, useEffect } from "react";
import { Monitor, Radio } from "lucide-react";
import { PacingMicroPanel, PovSection, GlobalPacingPanel } from "../RecordingQueueDrawer";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { friendlyClipTitleForQueue, humanizeCompilationKind } from "../../utils/montageUtils";

function clipTypeLabel(cd) {
  const cat = cd.category;
  const kind = cd.compilation_kind;
  const base =
    ({
      highlight: "高光",
      fail: "下饭",
      meme_death: "梗死亡",
      compilation: "合集",
    })[cat] || cat || "—";
  if (cat === "compilation" && kind) return `${base} · ${humanizeCompilationKind(kind)}`;
  return base;
}

function Row({ label, children, title }) {
  return (
    <div className="flex justify-between gap-2 border-b border-white/[0.04] py-1.5 text-[10px] last:border-0">
      <span className="shrink-0 text-zinc-600">{label}</span>
      <span className="min-w-0 break-all text-right text-zinc-300" title={title}>
        {children}
      </span>
    </div>
  );
}

/**
 * @param {{
 *   selectedId: string | null,
 *   selectedItem: import("../../stores/recordingQueueStore").RecordingQueueItem | null,
 *   queue: import("../../stores/recordingQueueStore").RecordingQueueItem[],
 * }} props
 */
export default function QueueInspectorPanel({ selectedId, selectedItem, queue }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const updateItemPacing = useRecordingQueue((s) => s.updateItemPacing);
  const toggleVictimPov = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPov = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);
  const [pacingExpandedId, setPacingExpandedId] = useState(null);

  useEffect(() => {
    setPacingExpandedId(null);
  }, [selectedId]);

  const globalPanel = (
    <GlobalPacingPanel
      defaultExpanded
      globalPacing={globalPacing}
      setGlobalPacing={setGlobalPacing}
      resetGlobalPacing={resetGlobalPacing}
      queue={queue}
      onToggleAllVictimPov={toggleVictimPov}
      onToggleAllKillerPov={toggleKillerPov}
    />
  );

  if (!selectedItem) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="shrink-0">{globalPanel}</div>
        <div className="shrink-0 border-b border-white/[0.06] px-2 py-1.5">
          <h2 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">检查器</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
          <Monitor className="mb-2 h-8 w-8 text-zinc-700" />
          <p className="text-[12px] font-semibold text-zinc-400">选择一个录制任务</p>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
            在左侧队列中点选片段，可查看剪辑节奏与回放选项。
          </p>
        </div>
      </div>
    );
  }

  const cd = selectedItem.clipData || {};
  const heading = friendlyClipTitleForQueue(cd);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0">{globalPanel}</div>

      <div className="shrink-0 border-b border-white/[0.06] px-2 py-1.5">
        <h2 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">检查器</h2>
        <p className="mt-0.5 line-clamp-2 text-[11px] font-semibold leading-snug text-zinc-200" title={heading}>
          {heading}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <section className="rounded-lg border border-white/[0.06] bg-black/25 px-2 py-2">
          <h3 className="mb-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
            <Radio className="h-3 w-3" /> 片段概览
          </h3>
          <div className="text-[10px] text-zinc-400">
            <Row label="类型">{clipTypeLabel(cd)}</Row>
            <Row label="Demo 文件" title={selectedItem.demoFilename}>
              {selectedItem.demoFilename || "—"}
            </Row>
            <Row label="目标玩家">{String(selectedItem.targetPlayer || "—")}</Row>
            <Row label="地图">{String(cd.map_name || cd.map || "—")}</Row>
            <Row label="回合 / 比分">
              {cd.round != null && cd.score_own != null && cd.score_opp != null
                ? `第 ${cd.round} 回合 · ${cd.score_own}:${cd.score_opp}`
                : cd.round != null
                  ? `第 ${cd.round} 回合`
                  : "—"}
            </Row>
            <Row label="击杀数">{Number(cd.kill_count) > 0 ? String(cd.kill_count) : "—"}</Row>
            <Row label="片段时长">
              {typeof cd.duration_sec === "number" && Number.isFinite(cd.duration_sec)
                ? `${cd.duration_sec.toFixed(1)}s`
                : "—"}
            </Row>
            <Row label="标签">
              {Array.isArray(cd.context_tags) && cd.context_tags.length
                ? cd.context_tags.join(" · ")
                : "—"}
            </Row>
            <Row label="回合合集勾选">
              {Array.isArray(selectedItem.freezeToDeathQueueRounds) &&
              selectedItem.freezeToDeathQueueRounds.length
                ? selectedItem.freezeToDeathQueueRounds.join("、")
                : "—"}
            </Row>
          </div>
        </section>

        {!cd.fixed_segment_pacing ? (
          <div className="mt-2">
            <PacingMicroPanel
              item={selectedItem}
              expanded={pacingExpandedId === selectedItem.id}
              updateItemPacing={updateItemPacing}
              onToggleExpand={(id) =>
                setPacingExpandedId((cur) => (cur === id ? null : id))
              }
            />
          </div>
        ) : (
          <p className="mt-2 rounded border border-amber-500/20 bg-amber-950/20 px-2 py-1.5 text-[10px] text-amber-200/90">
            固定 tick 合辑：智能开场/结尾预留对该条目不生效。
          </p>
        )}

        <div className="mt-2">
          <PovSection item={selectedItem} updateItemPacing={updateItemPacing} />
        </div>
      </div>
    </div>
  );
}
