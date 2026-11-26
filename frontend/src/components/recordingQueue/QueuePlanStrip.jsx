import { useId, useState } from "react";
import { usesGroupedReplays } from "../../utils/groupedCompilationReplays";
import { useT } from "../../i18n/useT.js";
import { getRecordingPlanPreview } from "../../utils/recordingPlanPreview";
import { mergedPacingForItem } from "../../utils/recordingQueueDerive";
import { isRoundTimelineRoundClip } from "../../utils/montageUtils";
import { isFreezeToDeathCompilation } from "../../utils/freezeToDeathRoundFilter";

const COLLAPSED_BLOCKS = 6;

const TONES = {
  pad: "bg-cs2-bg-input text-cs2-text-muted",
  kill: "bg-cs2-accent-soft text-cs2-accent",
  death: "bg-cs2-rose-surface text-cs2-rose-on-surface",
  victim: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
  killer: "bg-cs2-amber-surface text-cs2-amber-on-surface",
};

function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Number(n.toFixed(1))}s` : "";
}

/** Turn a recording plan into ordered blocks for the visual strip. */
export function buildPlanBlocks(item, globalPacing, roundPlan, t) {
  const clip = item?.clipData || {};
  if (usesGroupedReplays(item)) {
    if (roundPlan?.status !== "ready") return [];
    const { active_segments, tick_rate } = roundPlan.plan;
    const deaths = clip.compilation_kind === "all_deaths";
    const replayPov = deaths ? "killer" : "victim";
    let eventNumber = 0;
    return active_segments.map((segment) => {
      const pov = segment.perspective === replayPov;
      const posthumous = Boolean(segment.posthumous_kill);
      const duration = (segment.end_tick - segment.start_tick) / tick_rate;
      let label;
      if (pov) {
        const perspective = posthumous ? t("queue.posthumousTitle")
          : t(deaths ? "queue.killerPovLabel" : "queue.victimPovLabel");
        const name = segment.target_player_name;
        label = name ? t("queue.stripReplay", { perspective, name }) : perspective;
        if (posthumous) eventNumber += segment.anchor_ticks.length;
      } else {
        const first = eventNumber + 1;
        eventNumber += segment.anchor_ticks.length;
        const n = first === eventNumber ? first : `${first}–${eventNumber}`;
        label = t(deaths ? "queue.stripDeath" : "queue.stripKill", { n });
      }
      return {
        tone: pov ? replayPov : deaths ? "death" : "kill",
        label,
        sec: seconds(duration),
        flex: Math.max(duration, 1),
      };
    });
  }
  if (isFreezeToDeathCompilation(clip)) {
    if (roundPlan?.status !== "ready") return [];
    const { plan } = roundPlan;
    return plan.active_segments.map((segment) => {
      const sec = (segment.end_tick - segment.start_tick) / plan.tick_rate;
      return { tone: "death", label: t("queue.stripRound", { n: segment.round }), sec: seconds(sec), flex: Math.max(sec, 1) };
    });
  }
  if (isRoundTimelineRoundClip(clip)) {
    return [{ tone: "kill", label: t("queue.stripWholeRound", { n: clip.round ?? "—" }), sec: "", flex: 1 }];
  }
  const plan = getRecordingPlanPreview(item, globalPacing);
  if (!plan) return [{ tone: "kill", label: t("queue.stripClip"), sec: "", flex: 1 }];

  const po = item.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const { pre_first_sec: pre, post_last_sec: post } = mergedPacingForItem(item, globalPacing);
  const victims = (Array.isArray(clip.victims) ? clip.victims : []).map((v) => String(v ?? "").trim()).filter(Boolean);
  const killers = (Array.isArray(clip.killers) ? clip.killers : []).map((v) => String(v ?? "").trim()).filter(Boolean);
  const killerName = String(clip.killer_name ?? "").trim();
  const povSec = Number(po.victim_pov_pre_sec ?? 1.5) + Number(po.victim_pov_post_sec ?? 1.5) + 2;
  const replayLabel = (name, death) => t("queue.stripReplay", {
    perspective: t(death ? "queue.killerPovLabel" : "queue.victimPovLabel"),
    name,
  });
  const blocks = [{ tone: "pad", label: t("settings.presetPreShort"), sec: seconds(pre), flex: Math.max(pre, 0.6) }];
  const tail = { tone: "pad", label: t("settings.presetPostShort"), sec: seconds(post), flex: Math.max(post, 0.6) };
  switch (plan.variant) {
    case "posthumous_victim_only":
      return victims.slice(0, plan.eventCount).map((name) => ({
        tone: "victim", label: replayLabel(name, false), sec: "", flex: 1,
      }));
    case "fail_victim_only":
    case "fail_victim_killer_pair":
      blocks.push({ tone: "death", label: t("queue.stripMyDeath"), sec: "", flex: 2 }, tail);
      if (plan.variant === "fail_victim_killer_pair") {
        blocks.push({ tone: "killer", label: replayLabel(killerName || "—", true), sec: "", flex: povSec });
      }
      return blocks;
    case "kill_victim_interleaved":
    case "death_killer_interleaved": {
      const death = plan.variant === "death_killer_interleaved";
      const others = death ? killers : victims;
      for (let i = 0; i < plan.eventCount; i += 1) {
        blocks.push({ tone: death ? "death" : "kill", label: t(death ? "queue.stripDeath" : "queue.stripKill", { n: i + 1 }), sec: "", flex: 2.5 });
        blocks.push({ tone: death ? "killer" : "victim", label: replayLabel(others[i] || "—", death), sec: "", flex: povSec });
      }
      blocks.push(tail);
      return blocks;
    }
    default: {
      const death = plan.variant.startsWith("death");
      const main = Array.from({ length: plan.killerSegCount || 1 }, (_, i) => ({
        tone: death ? "death" : "kill",
        label: t(death ? "queue.stripDeath" : "queue.stripKill", { n: i + 1 }),
        sec: "",
        flex: 2.5,
      }));
      blocks.push(...main);
      blocks.push(tail);
      if (plan.variant === "kill_victim_batch" || plan.variant === "death_killer_batch") {
        const others = (death ? killers : victims).map((name) => ({
          tone: death ? "killer" : "victim",
          label: replayLabel(name, death),
          sec: "",
          flex: povSec,
        }));
        blocks.push(...others);
      }
      return blocks;
    }
  }
}

export function planSummaryKey(item, globalPacing) {
  const clip = item?.clipData || {};
  if (usesGroupedReplays(item)) return clip.compilation_kind === "all_deaths" ? "queue.povTimingDeathGroup" : "queue.povTimingGroup";
  if (isFreezeToDeathCompilation(clip)) return "queue.planSummary_rounds";
  if (isRoundTimelineRoundClip(clip)) return "queue.planSummary_whole_round";
  const plan = getRecordingPlanPreview(item, globalPacing);
  return plan ? `queue.planSummary_${plan.variant}` : "queue.planSummary_default";
}

/**
 * @param {{ item: object, globalPacing: object, roundPlan?: object, estimateSec?: number | null }} props
 */
export default function QueuePlanStrip({ item, globalPacing, roundPlan, estimateSec }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const blocks = buildPlanBlocks(item, globalPacing, roundPlan, t);
  const clip = item?.clipData || {};
  const hiddenCount = Math.max(0, blocks.length - COLLAPSED_BLOCKS);
  const showAll = expanded && hiddenCount > 0;
  const visibleBlocks = showAll ? blocks : blocks.slice(0, COLLAPSED_BLOCKS);
  const victims = Array.isArray(clip.victims) ? clip.victims.filter(Boolean).length : 0;
  return (
    <div className="space-y-2.5 px-4 py-3.5" data-testid="queue-plan-strip">
      {usesGroupedReplays(item) && roundPlan?.status !== "ready" && (
        roundPlan?.status === "error" ? (
          <p role="alert" className="text-xs text-cs2-text-error">
            {t("ftd.planFailed")} <button className="underline" onClick={roundPlan.retry}>{t("ftd.planRetry")}</button>
          </p>
        ) : <p role="status" className="text-xs text-cs2-text-muted">{t("ftd.planLoading")}</p>
      )}
      {blocks.length ? (
        <div className={showAll ? "space-y-2" : "flex w-full gap-1"}>
          <ol id={listId} className={showAll
            ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] gap-1"
            : "flex min-w-0 flex-1 gap-[3px]"}>
            {visibleBlocks.map((block, index) => (
              <li
                key={index}
                title={block.label}
                style={showAll ? undefined : { flex: block.flex }}
                className={`flex min-h-11 min-w-0 flex-col justify-center rounded-[5px] px-2 py-1 ${TONES[block.tone]}`}
              >
                <span className={`text-[11.5px] font-semibold ${showAll ? "[overflow-wrap:anywhere]" : "truncate"}`}>{block.label}</span>
                {block.sec ? <span className="truncate font-mono text-[10.5px] opacity-80">{block.sec}</span> : null}
              </li>
            ))}
          </ol>
          {hiddenCount > 0 && (
            <button
              type="button"
              aria-controls={listId}
              aria-expanded={showAll}
              onClick={() => setExpanded(!showAll)}
              className="ml-auto block shrink-0 rounded-[5px] bg-cs2-bg-input px-2 py-1 text-xs text-cs2-accent hover:underline"
            >
              {showAll ? t("queue.stripCollapse") : t("queue.stripExpand", { n: hiddenCount })}
            </button>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-cs2-text-secondary">
        <span>{t(planSummaryKey(item, globalPacing), { n: victims })}</span>
        <span>
          {t("queue.planEstimate", {
            seconds: Number.isFinite(estimateSec) ? Math.round(estimateSec) : "—",
          })}
        </span>
      </div>
    </div>
  );
}
