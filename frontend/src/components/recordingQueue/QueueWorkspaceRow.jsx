import {
  Trash2,
  Sparkles,
  Skull,
  Ghost,
  Layers,
  Crosshair,
  ChevronRight,
  GripVertical,
  History,
} from "lucide-react";
import QueueMiniTimeline from "./QueueMiniTimeline";
import { estimateItemRecordSeconds } from "../../utils/recordingQueueDerive";
import {
  formatClipCombatSummaryLine,
  friendlyClipTitleForQueue,
  isTimelineSourceClip,
} from "../../utils/montageUtils";
import {
  freezeToDeathQueueRoundBadgeText,
  isFreezeToDeathCompilation,
} from "../../utils/freezeToDeathRoundFilter";
import { timelineQueueMetaOneLiner } from "../../utils/timelineQueue";

const CAT_ICON = {
  highlight: Sparkles,
  fail: Skull,
  meme_death: Ghost,
  compilation: Layers,
};

function queueRowIconShellClass(timeline, cat) {
  const base =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border shadow-inner ";
  if (timeline) {
    return base + "border-cyan-500/35 bg-gradient-to-br from-cyan-950/55 to-black/50 text-cyan-200";
  }
  switch (cat) {
    case "highlight":
      return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
    case "fail":
      return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
    case "meme_death":
      return base + "border-fuchsia-500/35 bg-fuchsia-950/40 text-fuchsia-200";
    case "compilation":
      return base + "border-cs2-compilation/35 bg-cs2-compilation/10 text-cs2-compilation";
    default:
      return base + "border-white/12 bg-black/35 text-zinc-200";
  }
}

function queueRowCatTagClass(timeline, cat) {
  const base = "rounded border px-1.5 py-0 text-[9px] font-semibold ";
  if (timeline) {
    return base + "border-cyan-500/30 bg-cyan-500/10 text-cyan-200/95";
  }
  switch (cat) {
    case "highlight":
      return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
    case "fail":
      return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
    case "meme_death":
      return base + "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200/95";
    case "compilation":
      return base + "border-cs2-compilation/30 bg-cs2-compilation/10 text-cs2-compilation";
    default:
      return base + "border-white/12 bg-white/[0.04] text-zinc-400";
  }
}

function categoryZh(cat) {
  return (
    ({
      highlight: "高光",
      fail: "下饭",
      meme_death: "坐牢",
      compilation: "合集",
    })[cat] || cat || "片段"
  );
}

/**
 * @param {{
 *   item: import("../../stores/recordingQueueStore").RecordingQueueItem,
 *   priorityIndex: number,
 *   selected: boolean,
 *   onSelect: () => void,
 *   onRemove: () => void,
 *   globalPacing: Record<string, unknown>,
 *   queueIndex?: number,
 *   dragReorderEnabled?: boolean,
 *   onReorderDragStart?: () => void,
 *   onReorderDragEnd?: () => void,
 * }} props
 */
export default function QueueWorkspaceRow({
  item,
  priorityIndex,
  selected,
  onSelect,
  onRemove,
  globalPacing,
  queueIndex = 0,
  dragReorderEnabled = false,
  onReorderDragStart,
  onReorderDragEnd,
}) {
  const cd = item.clipData || {};
  const cat = cd.category || "";
  const timeline = isTimelineSourceClip(cd);
  const Icon = timeline ? History : CAT_ICON[cat] || Crosshair;
  const title = friendlyClipTitleForQueue(cd);
  const showTimeline = cat !== "compilation";
  const demoLabel = String(item.demoFilename || item.demoPath || "").trim() || "—";
  const playerLabel = String(item.targetPlayer || "").trim() || "—";
  const mapName = String(cd.map_name || cd.map || "").trim() || "—";
  const ftdRoundBadge = freezeToDeathQueueRoundBadgeText(item, cd);
  const roundLabel = (() => {
    if (isFreezeToDeathCompilation(cd)) {
      return ftdRoundBadge || "—";
    }
    if (cd.round != null && cd.score_own != null && cd.score_opp != null) {
      return `R${cd.round} · ${cd.score_own}:${cd.score_opp}`;
    }
    if (cd.round != null) {
      return `R${cd.round}`;
    }
    return "—";
  })();
  const kills = Number(cd.kill_count) || 0;
  const estSec = estimateItemRecordSeconds(item, globalPacing);
  const timelineMetaLine = timeline ? timelineQueueMetaOneLiner(cd, estSec) : "";
  const tags = Array.isArray(cd.context_tags) ? cd.context_tags.slice(0, 3) : [];
  const queueSummary = String(cd.queue_summary_line || "").trim();
  const combatSummary = !timeline ? formatClipCombatSummaryLine(cd) : "";
  const catBadgeZh = timeline ? "时间线" : categoryZh(cat);

  return (
    <div
      className={[
        "group flex w-full items-stretch gap-0.5 rounded-lg border px-1.5 py-2 text-left transition-colors sm:gap-1 sm:px-2",
        selected
          ? "border-cs2-orange/55 bg-cs2-orange/[0.07] shadow-[inset_0_0_0_1px_rgba(225,116,57,0.12)]"
          : "border-white/[0.06] bg-black/20 hover:border-white/15 hover:bg-white/[0.03]",
      ].join(" ")}
    >
      {dragReorderEnabled ? (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", String(queueIndex));
            e.dataTransfer.effectAllowed = "move";
            onReorderDragStart?.();
          }}
          onDragEnd={() => onReorderDragEnd?.()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="flex w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-zinc-600 active:cursor-grabbing hover:bg-white/[0.05] hover:text-zinc-400"
          title="拖动排序"
          aria-label="拖动调整顺序"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </div>
      ) : null}

      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className="flex min-w-0 flex-1 gap-2 outline-none focus-visible:ring-2 focus-visible:ring-cs2-orange/45"
      >
      <div className={queueRowIconShellClass(timeline, cat)}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-zinc-500">
            #{priorityIndex}
            <ChevronRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          <span className="truncate text-[11px] font-semibold text-zinc-200">{title}</span>
          <span className={queueRowCatTagClass(timeline, cat)}>
            {catBadgeZh}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-snug">
          <span className="font-mono text-zinc-400" title="Demo 文件">
            Demo <span className="text-zinc-300">{demoLabel}</span>
          </span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-400">
            玩家 <span className="font-semibold text-zinc-200">{playerLabel}</span>
          </span>
        </div>
        {queueSummary ? (
          <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-cyan-100/85">{queueSummary}</p>
        ) : null}
        {!timeline && combatSummary ? (
          <p
            className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-400"
            title={combatSummary}
          >
            {combatSummary}
          </p>
        ) : null}
        {timeline ? (
          <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-400">{timelineMetaLine}</p>
        ) : (
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-zinc-500">
            <span title="地图">{mapName}</span>
            <span title="回合 / 比分">{roundLabel}</span>
            <span>{kills > 0 ? `${kills} 杀` : "—"}</span>
            <span className="text-zinc-600">~{estSec}s</span>
          </div>
        )}
        {!timeline && tags.length > 0 ? (
          <p className="mt-0.5 truncate text-[9px] text-zinc-600">{tags.join(" · ")}</p>
        ) : null}
        {showTimeline ? (
          <QueueMiniTimeline
            clipData={cd}
            pacingOverride={item.pacing_override}
            globalPacing={globalPacing}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
        <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0 text-[9px] font-semibold text-emerald-400/90">
          待录
        </span>
        <span className="font-mono text-[9px] text-zinc-600">P{priorityIndex}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-1 text-zinc-600 opacity-60 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
          aria-label="移除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>
    </div>
  );
}
