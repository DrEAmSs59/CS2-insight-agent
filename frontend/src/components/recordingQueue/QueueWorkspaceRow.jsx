import {
  AlertTriangle,
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
import { isFreezeToDeathCompilation } from "../../utils/freezeToDeathRoundFilter";
import { useRoundCompilationPlan } from "../../recording/useRoundCompilationPlans";
import { queueItemHasPacingOverride, queueItemRoundLabel } from "./QueueInspectorPanel";

const CAT_ICON = {
  highlight: Sparkles,
  fail: Skull,
  meme_death: Ghost,
  compilation: Layers,
};

function iconClass(timeline, category) {
  const base = "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg ";
  if (timeline) return base + "bg-cs2-cyan-surface text-cs2-cyan-on-surface";
  if (category === "highlight") return base + "bg-cs2-emerald-surface text-cs2-emerald-on-surface";
  if (category === "fail") return base + "bg-cs2-rose-surface text-cs2-rose-on-surface";
  if (category === "meme_death") return base + "bg-cs2-fuchsia-surface text-cs2-fuchsia-on-surface";
  if (category === "compilation") return base + "bg-cs2-amber-surface text-cs2-amber-on-surface";
  return base + "bg-cs2-bg-input text-cs2-text-secondary";
}

/**
 * One compact queue entry: what it is, where it comes from and how long it records.
 * The full parameters live in the editor next to the list.
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
  const roundPlan = useRoundCompilationPlan(item);
  const clip = item.clipData || {};
  const category = clip.category || "";
  const timeline = isTimelineSourceClip(clip);
  const Icon = timeline ? History : CAT_ICON[category] || Crosshair;
  const playerLabel = String(item.targetPlayer || clip.player_name || "").trim();
  const mapName = String(clip.map_name || clip.map || "").trim();
  const meta = [playerLabel, mapName, queueItemRoundLabel(item, clip, t)].filter(Boolean).join(" · ");
  const estimate = estimateItemRecordSeconds(item, globalPacing, roundPlan);
  const po = item.pacing_override || {};
  const hasPov = Boolean(po.victim_pov || po.killer_pov);
  const edited = queueItemHasPacingOverride(item);
  const inputMissing = item.demoHasPlayerKeyboardInput === false;
  const demoLabel = String(item.demoFilename || item.demoPath || "").trim();

  return (
    <div
      className={[
        "group flex w-full items-center gap-1 rounded-lg border py-2 pl-1 pr-2 transition-colors",
        selected
          ? "border-cs2-accent/45 bg-cs2-accent-soft"
          : "border-transparent hover:bg-cs2-bg-hover",
      ].join(" ")}
    >
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
          className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center rounded text-cs2-text-muted opacity-60 active:cursor-grabbing hover:bg-cs2-bg-hover hover:opacity-100"
          title={t("queue.rowDragTitle")}
          aria-label={t("queue.rowDragAriaLabel")}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </div>
      ) : (
        <span className="w-5 shrink-0 text-center font-mono text-[10px] tabular-nums text-cs2-text-muted">{priorityIndex}</span>
      )}

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={demoLabel || undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/45"
      >
        <span className={iconClass(timeline, category)}><Icon className="h-4 w-4" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-cs2-text-primary">{friendlyClipTitleForQueue(clip, t)}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-cs2-text-muted">{meta || "—"}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-[11.5px] tabular-nums text-cs2-text-secondary">
            {Number.isFinite(estimate) ? `~${isFreezeToDeathCompilation(clip) ? estimate.toFixed(1) : Math.round(estimate)}s` : "—"}
          </span>
          <span className="flex gap-1">
            {inputMissing ? (
              <span
                data-testid="queue-input-hud-warning"
                role="img"
                aria-label={t("queue.inputHudMissingTitle")}
                title={`${t("queue.inputHudMissingTitle")} · ${t("queue.inputHudMissingBody")}`}
                className="inline-flex h-[17px] items-center rounded px-1 text-cs2-amber-on-surface"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden />
              </span>
            ) : null}
            {hasPov ? (
              <span className="inline-flex h-[17px] items-center rounded bg-cs2-cyan-surface px-1.5 text-[10px] font-semibold text-cs2-cyan-on-surface">
                {t("queue.rowMarkPov")}
              </span>
            ) : null}
            {edited ? (
              <span className="inline-flex h-[17px] items-center rounded bg-cs2-accent-soft px-1.5 text-[10px] font-semibold text-cs2-accent">
                {t("queue.rowMarkEdited")}
              </span>
            ) : null}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="rounded p-1 text-cs2-text-muted opacity-0 transition-opacity hover:bg-cs2-rose-surface hover:text-cs2-rose-on-surface focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={t("queue.rowRemoveAriaLabel")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
