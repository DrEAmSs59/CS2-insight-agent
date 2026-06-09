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
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore";
import { labelTag } from "../../utils/tagDescriptions";
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
    return base + "border-cs2-cyan-surface bg-cs2-cyan-surface text-cs2-cyan-on-surface";
  }
  switch (cat) {
    case "highlight":
      return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
    case "fail":
      return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
    case "meme_death":
      return base + "border-fuchsia-500/35 bg-cs2-fuchsia-surface text-cs2-fuchsia-on-surface";
    case "compilation":
      return base + "border-cs2-compilation/35 bg-cs2-compilation/10 text-cs2-compilation";
    default:
      return base + "border-cs2-border bg-cs2-bg-input/60 text-cs2-text-primary";
  }
}

function queueRowCatTagClass(timeline, cat) {
  const base = "rounded border px-1.5 py-0.5 text-[10px] font-semibold ";
  if (timeline) {
    return base + "border-cyan-500/30 bg-cyan-500/10 text-cs2-cyan-on-surface";
  }
  switch (cat) {
    case "highlight":
      return base + "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
    case "fail":
      return base + "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
    case "meme_death":
      return base + "border-fuchsia-500/30 bg-fuchsia-500/10 text-cs2-fuchsia-on-surface/95";
    case "compilation":
      return base + "border-cs2-compilation/30 bg-cs2-compilation/10 text-cs2-compilation";
    default:
      return base + "border-cs2-border bg-cs2-bg-hover text-cs2-text-secondary";
  }
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
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const cd = item.clipData || {};
  const cat = cd.category || "";
  const timeline = isTimelineSourceClip(cd);
  const Icon = timeline ? History : CAT_ICON[cat] || Crosshair;
  const title = friendlyClipTitleForQueue(cd, t);
  const showTimeline = cat !== "compilation";
  const demoLabel = String(item.demoFilename || item.demoPath || "").trim() || "—";
  const playerLabel = String(item.targetPlayer || "").trim() || "—";
  const mapName = String(cd.map_name || cd.map || "").trim() || "—";
  const ftdRoundBadge = freezeToDeathQueueRoundBadgeText(item, cd, t);
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
  const timelineMetaLine = timeline ? timelineQueueMetaOneLiner(cd, estSec, t) : "";
  const tags = Array.isArray(cd.context_tags) ? cd.context_tags.slice(0, 3) : [];
  const queueSummary = String(cd.queue_summary_line || "").trim();
  const combatSummary = !timeline ? formatClipCombatSummaryLine(cd, t, locale) : "";
  const categoryKey = timeline
    ? "queue.rowCatTimeline"
    : ({
        highlight: "queue.rowCatHighlight",
        fail: "queue.rowCatFail",
        meme_death: "queue.rowCatMemeDeath",
        compilation: "queue.rowCatCompilation",
      })[cat] || "queue.rowCatDefault";
  const catBadge = t(categoryKey);

  return (
    <div
      className={[
        "group flex w-full items-stretch gap-0.5 rounded-lg border px-1.5 py-2 text-left transition-colors sm:gap-1 sm:px-2",
        selected
          ? "border-cs2-accent/55 bg-cs2-accent/[0.07] shadow-[inset_0_0_0_1px_rgba(225,116,57,0.12)]"
          : "border-cs2-border bg-cs2-bg-input/30 hover:border-cs2-border hover:bg-cs2-bg-hover",
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
          className="flex w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-cs2-text-muted active:cursor-grabbing hover:bg-cs2-bg-hover hover:text-cs2-text-secondary"
          title={t("queue.rowDragTitle")}
          aria-label={t("queue.rowDragAriaLabel")}
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
        className="flex min-w-0 flex-1 gap-2 outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/45"
      >
      <div className={queueRowIconShellClass(timeline, cat)}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-center gap-1 font-mono text-[12px] tabular-nums text-cs2-text-muted">
            #{priorityIndex}
            <ChevronRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          <span className="truncate text-[13px] font-semibold text-cs2-text-primary">{title}</span>
          <span className={queueRowCatTagClass(timeline, cat)}>
            {catBadge}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] leading-snug">
          <span className="font-mono text-cs2-text-secondary" title="Demo">
            Demo <span className="text-cs2-text-secondary">{demoLabel}</span>
          </span>
          <span className="text-cs2-text-muted">·</span>
          <span className="text-cs2-text-secondary">
            {t("queue.rowPlayer")} <span className="font-semibold text-cs2-text-primary">{playerLabel}</span>
          </span>
        </div>
        {queueSummary ? (
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-cs2-text-secondary">{queueSummary}</p>
        ) : null}
        {!timeline && combatSummary ? (
          <p
            className="mt-1 line-clamp-2 text-[12px] leading-snug text-cs2-text-secondary"
            title={combatSummary}
          >
            {combatSummary}
          </p>
        ) : null}
        {timeline ? (
          <p className="mt-1.5 font-mono text-[12px] leading-snug text-cs2-text-secondary">{timelineMetaLine}</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[12px] text-cs2-text-muted">
            <span>{mapName}</span>
            <span>{roundLabel}</span>
            <span>{kills > 0 ? t("queue.rowKills", { n: kills }) : "—"}</span>
            <span className="text-cs2-text-muted">~{estSec}s</span>
          </div>
        )}
        {!timeline && tags.length > 0 ? (
          <p className="mt-1 text-[11px] text-cs2-text-muted">{tags.map((tg) => labelTag(tg, locale)).join(" · ")}</p>
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
        <span className="rounded border border-cs2-emerald-surface bg-cs2-emerald-surface px-1.5 py-0.5 text-[10px] font-semibold text-cs2-emerald-on-surface">
          {t("queue.rowPendingBadge")}
        </span>
        <span className="font-mono text-[10px] text-cs2-text-muted">P{priorityIndex}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-1 text-cs2-text-muted opacity-60 transition-opacity hover:bg-cs2-rose-surface hover:text-cs2-rose-on-surface group-hover:opacity-100"
          aria-label={t("queue.rowRemoveAriaLabel")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>
    </div>
  );
}
