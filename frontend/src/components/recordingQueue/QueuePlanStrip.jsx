import { useT } from "../../i18n/useT.js";
import { getRecordingPlanPreview } from "../../utils/recordingPlanPreview";
import { mergedPacingForItem } from "../../utils/recordingQueueDerive";
import { isRoundTimelineRoundClip } from "../../utils/montageUtils";
import { isFreezeToDeathCompilation } from "../../utils/freezeToDeathRoundFilter";

const MAX_BLOCKS = 6;

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
  if (isFreezeToDeathCompilation(clip)) {
    if (roundPlan?.status !== "ready") return [];
    const { plan } = roundPlan;
    return plan.active_segments.slice(0, MAX_BLOCKS * 2).map((segment) => {
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
  const pushCapped = (list, total, more) => {
    blocks.push(...list.slice(0, MAX_BLOCKS));
    if (total > MAX_BLOCKS) blocks.push({ tone: more, label: t("queue.stripMore", { n: total - MAX_BLOCKS }), sec: "", flex: 1.5 });
  };

  switch (plan.variant) {
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
      const pairs = [];
      for (let i = 0; i < plan.eventCount; i += 1) {
        pairs.push({ tone: death ? "death" : "kill", label: t(death ? "queue.stripDeath" : "queue.stripKill", { n: i + 1 }), sec: "", flex: 2.5 });
        pairs.push({ tone: death ? "killer" : "victim", label: replayLabel(others[i] || "—", death), sec: "", flex: povSec });
      }
      pushCapped(pairs, pairs.length, death ? "death" : "kill");
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
      pushCapped(main, main.length, death ? "death" : "kill");
      blocks.push(tail);
      if (plan.variant === "kill_victim_batch" || plan.variant === "death_killer_batch") {
        const others = (death ? killers : victims).map((name) => ({
          tone: death ? "killer" : "victim",
          label: replayLabel(name, death),
          sec: "",
          flex: povSec,
        }));
        pushCapped(others, others.length, death ? "killer" : "victim");
      }
      return blocks;
    }
  }
}

export function planSummaryKey(item, globalPacing) {
  const clip = item?.clipData || {};
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
  const blocks = buildPlanBlocks(item, globalPacing, roundPlan, t);
  const clip = item?.clipData || {};
  const victims = Array.isArray(clip.victims) ? clip.victims.filter(Boolean).length : 0;
  return (
    <div className="space-y-2.5 px-4 py-3.5" data-testid="queue-plan-strip">
      {blocks.length ? (
        <div className="flex h-11 w-full gap-[3px]" aria-hidden>
          {blocks.map((block, index) => (
            <div
              key={`${block.label}-${index}`}
              style={{ flex: block.flex }}
              className={`flex min-w-[46px] flex-col justify-center overflow-hidden whitespace-nowrap rounded-[5px] px-2 ${TONES[block.tone]}`}
            >
              <span className="truncate text-[11.5px] font-semibold">{block.label}</span>
              {block.sec ? <span className="font-mono text-[10.5px] opacity-80">{block.sec}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-cs2-text-secondary">
        <span>{t(planSummaryKey(item, globalPacing), { n: victims })}</span>
        <span>
          {t("queue.planEstimate", {
            seconds: Number.isFinite(Number(estimateSec)) ? Math.round(Number(estimateSec)) : "—",
          })}
        </span>
      </div>
    </div>
  );
}
