import { Monitor, Settings, Eye } from "lucide-react";
import {
  PacingMicroPanel,
  PovSection,
  GlobalPacingPanel,
  killBadgeColorClass,
} from "../RecordingQueueDrawer";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { AiScoreBadge } from "../ClipCard";
import {
  getMontageBlockShortLabel,
  isClipPacingAndPovLocked,
  isRoundTimelineRoundClip,
  isTimelineSourceClip,
} from "../../utils/montageUtils";
import {
  freezeToDeathQueueRoundBadgeText,
  isFreezeToDeathCompilation,
} from "../../utils/freezeToDeathRoundFilter";
import { estimateItemRecordSeconds } from "../../utils/recordingQueueDerive";

function FieldGroup({ icon: Icon, title, children }) {
  return (
    <div className="overflow-hidden rounded border border-white/[0.05] bg-black/20">
      <div className="flex items-center gap-1.5 border-b border-white/[0.05] px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {Icon ? <Icon className="h-3 w-3 text-zinc-500" /> : null}
        <span>{title}</span>
      </div>
      <div className="p-2">{children}</div>
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
export default function QueueInspectorPanel({ selectedId: _selectedId, selectedItem, queue }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const updateItemPacing = useRecordingQueue((s) => s.updateItemPacing);
  const toggleVictimPov = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPov = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);

  const globalPanel = (
    <GlobalPacingPanel
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
  const hideQueueAi = isTimelineSourceClip(cd) || cd.category === "compilation";
  const killBadge = getMontageBlockShortLabel(cd);
  const playerName = String(selectedItem.targetPlayer || cd.player_name || "—").trim() || "—";
  const round = cd.round != null && Number.isFinite(Number(cd.round)) ? Number(cd.round) : null;
  const ftdRoundBadge = freezeToDeathQueueRoundBadgeText(selectedItem, cd);
  const own = cd.score_own != null ? Number(cd.score_own) : null;
  const opp = cd.score_opp != null ? Number(cd.score_opp) : null;
  const hasScorePair = own != null && opp != null && Number.isFinite(own) && Number.isFinite(opp);
  const mapName = String(cd.map_name || cd.map || "").trim();
  const aiScore = cd.ai_score;
  const weaponPrimary =
    cd.weapon_used &&
    String(cd.weapon_used)
      .split(" / ")
      .map((w) => w.trim())
      .filter(Boolean)[0];
  const tags = Array.isArray(cd.context_tags) ? cd.context_tags.slice(0, 5) : [];
  const estSec = estimateItemRecordSeconds(selectedItem, globalPacing);
  const victimsCount = Array.isArray(cd.victims) ? cd.victims.length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0">{globalPanel}</div>

      <div className="shrink-0 border-b border-white/[0.06] px-2 py-1.5">
        <h2 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">检查器</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {/* 片段摘要卡 */}
        <div className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-black/25 p-2">
          {killBadge ? (
            <div
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold leading-tight ${killBadgeColorClass(cd)}`}
              title={killBadge}
            >
              {killBadge}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">
                {playerName}
              </span>
              <div className="ml-auto shrink-0">
                {hideQueueAi ? null : <AiScoreBadge score={aiScore} />}
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {hasScorePair ? (
                <>
                  <span className="rounded bg-sky-500/15 px-1.5 py-px font-mono text-[10px] font-semibold text-sky-200">
                    CT {own}
                  </span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-px font-mono text-[10px] font-semibold text-amber-200">
                    T {opp}
                  </span>
                </>
              ) : null}
              {isFreezeToDeathCompilation(cd) && ftdRoundBadge ? (
                <span className="rounded border border-white/[0.08] bg-black/30 px-1.5 py-px font-mono text-[10px] text-zinc-300">
                  {ftdRoundBadge}
                </span>
              ) : round != null ? (
                <span className="rounded border border-white/[0.08] bg-black/30 px-1.5 py-px font-mono text-[10px] text-zinc-300">
                  R{round}
                </span>
              ) : null}
              {mapName ? (
                <span className="truncate text-[10px] text-zinc-500" title={mapName}>
                  {mapName}
                </span>
              ) : null}
            </div>
            {(weaponPrimary || tags.length > 0) && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {weaponPrimary ? (
                  <span className="rounded border border-white/[0.08] bg-zinc-800/60 px-1.5 py-px font-mono text-[10px] text-zinc-300">
                    {weaponPrimary}
                  </span>
                ) : null}
                {tags.map((t) => (
                  <span
                    key={t}
                    className="rounded border border-white/[0.06] bg-zinc-800/40 px-1.5 py-px text-[10px] text-zinc-400"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stat 卡 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-white/[0.06] bg-black/25 px-2 py-1.5">
            <p className="text-[10px] text-zinc-500">预计录制时长</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cs2-orange">
              {Number.isFinite(estSec) ? `${Number(estSec).toFixed(0)}s` : "—"}
            </p>
          </div>
          <div className="rounded border border-white/[0.06] bg-black/25 px-2 py-1.5">
            <p className="text-[10px] text-zinc-500">可追加视角数</p>
            <p className="mt-0.5 font-mono text-[16px] font-bold text-cyan-300">
              {victimsCount}
            </p>
          </div>
        </div>

        {/* 节奏面板 */}
        <FieldGroup icon={Settings} title="剪辑节奏">
          {isClipPacingAndPovLocked(cd) ? (
            <p className="rounded border border-amber-500/20 bg-amber-950/20 px-2 py-1.5 text-[10px] text-amber-200/90">
              {isRoundTimelineRoundClip(cd)
                ? "整回合时间线为固定 tick 窗口，智能击杀前/击杀后预留对该条目不生效。"
                : "回合死亡合集为固定分段合辑，智能击杀前/击杀后预留对该条目不生效。"}
            </p>
          ) : (
            <PacingMicroPanel
              item={selectedItem}
              updateItemPacing={updateItemPacing}
            />
          )}
        </FieldGroup>

        {/* 视角面板 */}
        <FieldGroup icon={Eye} title="回看视角">
          <PovSection item={selectedItem} updateItemPacing={updateItemPacing} />
        </FieldGroup>
      </div>
    </div>
  );
}
