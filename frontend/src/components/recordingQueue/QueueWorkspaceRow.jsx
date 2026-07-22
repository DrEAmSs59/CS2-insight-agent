import {
  ChevronRight,
  Crosshair,
  Ghost,
  GripVertical,
  History,
  Layers,
  Skull,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { estimateItemRecordSeconds } from "../../utils/recordingQueueDerive";
import { friendlyClipTitleForQueue, isTimelineSourceClip } from "../../utils/montageUtils";
import { freezeToDeathQueueRoundBadgeText, isFreezeToDeathCompilation } from "../../utils/freezeToDeathRoundFilter";

const CAT_ICON = {
  highlight: Sparkles,
  fail: Skull,
  meme_death: Ghost,
  compilation: Layers,
};

function iconClass(timeline, category) {
  const base = "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ";
  if (timeline) return base + "border-cs2-cyan-surface bg-cs2-cyan-surface text-cs2-cyan-on-surface";
  if (category === "highlight") return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
  if (category === "fail") return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
  if (category === "meme_death") return base + "border-fuchsia-500/30 bg-cs2-fuchsia-surface text-cs2-fuchsia-on-surface";
  if (category === "compilation") return base + "border-cs2-compilation/30 bg-cs2-compilation/10 text-cs2-compilation";
  return base + "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary";
}

function categoryClass(timeline, category) {
  const base = "rounded border px-1.5 py-0.5 text-[9px] font-semibold ";
  if (timeline) return base + "border-cyan-500/30 bg-cyan-500/10 text-cs2-cyan-on-surface";
  if (category === "highlight") return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
  if (category === "fail") return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
  if (category === "meme_death") return base + "border-fuchsia-500/30 bg-fuchsia-500/10 text-cs2-fuchsia-on-surface";
  if (category === "compilation") return base + "border-cs2-compilation/30 bg-cs2-compilation/10 text-cs2-compilation";
  return base + "border-cs2-border bg-cs2-bg-hover text-cs2-text-secondary";
}

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
  const t = useT();
  const clip = item.clipData || {};
  const category = clip.category || "";
  const timeline = isTimelineSourceClip(clip);
  const Icon = timeline ? History : CAT_ICON[category] || Crosshair;
  const demoLabel = String(item.demoFilename || item.demoPath || "").trim() || "—";
  const playerLabel = String(item.targetPlayer || clip.player_name || "").trim() || "—";
  const mapName = String(clip.map_name || clip.map || "").trim() || "—";
  const roundLabel = isFreezeToDeathCompilation(clip)
    ? freezeToDeathQueueRoundBadgeText(item, clip, t) || "—"
    : clip.round != null
      ? clip.score_own != null && clip.score_opp != null
        ? `R${clip.round} · ${clip.score_own}:${clip.score_opp}`
        : `R${clip.round}`
      : "—";
  const estimate = estimateItemRecordSeconds(item, globalPacing);
  const categoryKey = timeline
    ? "queue.rowCatTimeline"
    : ({
        highlight: "queue.rowCatHighlight",
        fail: "queue.rowCatFail",
        meme_death: "queue.rowCatMemeDeath",
        compilation: "queue.rowCatCompilation",
      })[category] || "queue.rowCatDefault";

  return (
    <div className={[
      "group flex w-full items-stretch rounded-lg border px-1.5 py-2 transition-colors",
      selected
        ? "border-cs2-accent/55 bg-cs2-accent/[0.07] shadow-[inset_0_0_0_1px_rgba(225,116,57,0.12)]"
        : "border-cs2-border bg-cs2-bg-input/30 hover:bg-cs2-bg-hover",
    ].join(" ")}>
      {dragReorderEnabled ? (
        <div
          draggable
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.setData("text/plain", String(queueIndex));
            event.dataTransfer.effectAllowed = "move";
            onReorderDragStart?.();
          }}
          onDragEnd={() => onReorderDragEnd?.()}
          onClick={(event) => event.stopPropagation()}
          className="flex w-6 shrink-0 cursor-grab items-center justify-center rounded text-cs2-text-muted active:cursor-grabbing hover:bg-cs2-bg-hover hover:text-cs2-text-secondary"
          title={t("queue.rowDragTitle")}
          aria-label={t("queue.rowDragAriaLabel")}
        >
          <GripVertical className="h-4 w-4" />
        </div>
      ) : null}

      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className="flex min-w-0 flex-1 items-start gap-2 outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/45"
      >
        <div className={iconClass(timeline, category)}><Icon className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-cs2-text-muted">#{priorityIndex}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-cs2-text-primary">{friendlyClipTitleForQueue(clip, t)}</span>
            <span className={categoryClass(timeline, category)}>{t(categoryKey)}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-cs2-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <p className="mt-1 truncate text-[11px] text-cs2-text-secondary" title={`${playerLabel} · ${demoLabel}`}>
            <span className="font-semibold text-cs2-text-primary">{playerLabel}</span>
            <span className="mx-1.5 text-cs2-text-muted">·</span>
            <span className="font-mono">{demoLabel}</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] tabular-nums text-cs2-text-muted">
            <span>{mapName}</span>
            <span>{roundLabel}</span>
            <span>~{estimate}s</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="ml-1 self-start rounded p-1 text-cs2-text-muted opacity-60 transition-opacity hover:bg-cs2-rose-surface hover:text-cs2-rose-on-surface group-hover:opacity-100"
        aria-label={t("queue.rowRemoveAriaLabel")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
