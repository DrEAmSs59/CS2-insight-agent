import { mergedPacingForItem } from "./recordingQueueDerive";
import { DEMO_TICK_RATE, isTimelineSourceClip } from "./montageUtils";

/**
 * Group kill/death ticks by jump-cut threshold (mirrors backend planner merge).
 * @param {number[]} ticks
 * @param {number} thresholdTicks
 * @returns {number[][]}
 */
export function groupTicksByThreshold(ticks, thresholdTicks) {
  const sorted = [...ticks]
    .map(Number)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= thresholdTicks) {
      groups[groups.length - 1].push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups;
}

/** @param {Record<string, unknown>} clipData */
function extractEventTicks(clipData) {
  if (Array.isArray(clipData?.kill_ticks)) {
    return clipData.kill_ticks.map(Number).filter(Number.isFinite);
  }
  const kc = Number(clipData?.kill_count);
  if (Number.isFinite(kc) && kc > 0) {
    return Array.from({ length: Math.min(kc, 32) }, (_, i) => i);
  }
  return [];
}

/**
 * Build playback-order chip tokens for UI (K=killer, V=victim/death POV).
 * @param {import("./recordingPlanPreview").RecordingPlanPreview} plan
 * @returns {string[]}
 */
export function planPreviewToTokens(plan) {
  if (!plan) return [];
  const { variant, killerSegCount = 0, povSegCount = 0, eventCount = 0 } = plan;

  switch (variant) {
    case "kill_only":
      return Array.from({ length: Math.min(killerSegCount, 8) }, () => "K");
    case "kill_victim_batch": {
      const ks = Array.from({ length: Math.min(killerSegCount, 6) }, () => "K");
      const vs = Array.from({ length: Math.min(povSegCount, 6) }, () => "V");
      return ks.length && vs.length ? [...ks, "→", ...vs] : [...ks, ...vs];
    }
    case "kill_victim_interleaved": {
      const n = Math.min(eventCount, 6);
      const out = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) out.push("·");
        out.push("K", "V");
      }
      if (eventCount > 6) out.push("…");
      return out;
    }
    case "fail_victim_only":
      return ["V"];
    case "fail_victim_killer_pair":
      return ["V", "K"];
    case "death_only":
      return Array.from({ length: Math.min(killerSegCount || 1, 6) }, () => "V");
    case "death_killer_batch": {
      const vs = Array.from({ length: Math.min(killerSegCount, 6) }, () => "V");
      const ks = Array.from({ length: Math.min(povSegCount, 6) }, () => "K");
      return vs.length && ks.length ? [...vs, "→", ...ks] : [...vs, ...ks];
    }
    case "death_killer_interleaved": {
      const n = Math.min(eventCount, 6);
      const out = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) out.push("·");
        out.push("V", "K");
      }
      if (eventCount > 6) out.push("…");
      return out;
    }
    default:
      return [];
  }
}

/**
 * @typedef {Object} RecordingPlanPreview
 * @property {string} variant
 * @property {number} [eventCount]
 * @property {number} [killerSegCount]
 * @property {number} [povSegCount]
 * @property {number} [totalSegCount]
 */

/**
 * Derive human-readable recording plan summary for queue UI.
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {Record<string, unknown>} globalPacing
 * @returns {RecordingPlanPreview | null}
 */
export function getRecordingPlanPreview(item, globalPacing) {
  const clip = item?.clipData || {};
  const po = item?.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const cat = String(clip.category || "");
  const compKind = String(clip.compilation_kind || "");
  const victimPov = Boolean(po.victim_pov);
  const killerPov = Boolean(po.killer_pov);
  const interleaved = Boolean(po.pov_interleaved);

  const { max_gap_sec } = mergedPacingForItem(item, globalPacing);
  const thresholdTicks = max_gap_sec * DEMO_TICK_RATE;
  const eventTicks = extractEventTicks(clip);
  const eventCount = eventTicks.length;

  const isKillCompilation = cat === "compilation" && ["rival_kills", "all_kills", "weapon_kills"].includes(compKind);
  const isDeathCompilation = cat === "compilation" && ["nemesis_deaths", "all_deaths"].includes(compKind);
  const isHighlight = cat === "highlight" && eventCount > 0;
  const isFail = cat === "fail";
  const isTimelineKill =
    isTimelineSourceClip(clip) && String(clip.timeline_record_kind || "") === "kill";

  if (isFail) {
    if (killerPov) {
      return { variant: "fail_victim_killer_pair", eventCount: 1, killerSegCount: 1, povSegCount: 1, totalSegCount: 2 };
    }
    return { variant: "fail_victim_only", eventCount: 1, killerSegCount: 1, povSegCount: 0, totalSegCount: 1 };
  }

  if (isTimelineKill && eventCount <= 1) {
    if (victimPov) {
      return { variant: "kill_victim_interleaved", eventCount: 1, killerSegCount: 1, povSegCount: 1, totalSegCount: 2 };
    }
    return { variant: "kill_only", eventCount: 1, killerSegCount: 1, povSegCount: 0, totalSegCount: 1 };
  }

  if (isHighlight || isKillCompilation) {
    if (!victimPov) {
      const groups = groupTicksByThreshold(eventTicks, thresholdTicks);
      const killerSegCount = groups.length || (eventCount > 0 ? 1 : 0);
      return {
        variant: "kill_only",
        eventCount,
        killerSegCount,
        povSegCount: 0,
        totalSegCount: killerSegCount,
      };
    }
    if (interleaved) {
      return {
        variant: "kill_victim_interleaved",
        eventCount,
        killerSegCount: eventCount,
        povSegCount: eventCount,
        totalSegCount: eventCount * 2,
      };
    }
    const groups = groupTicksByThreshold(eventTicks, thresholdTicks);
    const killerSegCount = groups.length || eventCount;
    return {
      variant: "kill_victim_batch",
      eventCount,
      killerSegCount,
      povSegCount: eventCount,
      totalSegCount: killerSegCount + eventCount,
    };
  }

  if (isDeathCompilation) {
    if (!killerPov) {
      const groups = groupTicksByThreshold(eventTicks, thresholdTicks);
      const killerSegCount = groups.length || (eventCount > 0 ? 1 : 0);
      return {
        variant: "death_only",
        eventCount,
        killerSegCount,
        povSegCount: 0,
        totalSegCount: killerSegCount,
      };
    }
    if (interleaved) {
      return {
        variant: "death_killer_interleaved",
        eventCount,
        killerSegCount: eventCount,
        povSegCount: eventCount,
        totalSegCount: eventCount * 2,
      };
    }
    const groups = groupTicksByThreshold(eventTicks, thresholdTicks);
    const killerSegCount = groups.length || eventCount;
    return {
      variant: "death_killer_batch",
      eventCount,
      killerSegCount,
      povSegCount: eventCount,
      totalSegCount: killerSegCount + eventCount,
    };
  }

  return null;
}
