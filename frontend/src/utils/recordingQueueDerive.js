import { BACKEND_DEFAULT_PACING } from "../stores/recordingQueueStore";
import { DEMO_TICK_RATE } from "./montageUtils";

/** @param {Record<string, unknown>} gp */
function gNum(gp, key) {
  const v = gp[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {Record<string, unknown>} globalPacing
 */
export function mergedPacingForItem(item, globalPacing) {
  const gp = globalPacing && typeof globalPacing === "object" ? globalPacing : {};
  const po = item.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const pre = po.pre_first_sec ?? gNum(gp, "pre_first_sec") ?? BACKEND_DEFAULT_PACING.pre_first_sec;
  const post = po.post_last_sec ?? gNum(gp, "post_last_sec") ?? BACKEND_DEFAULT_PACING.post_last_sec;
  const mid =
    po.max_gap_sec != null
      ? po.max_gap_sec
      : gNum(gp, "max_gap_sec") ?? BACKEND_DEFAULT_PACING.max_gap_sec;
  return {
    pre_first_sec: pre,
    post_last_sec: post,
    max_gap_sec: mid,
  };
}

/**
 * Group kill ticks into segments by jump-cut threshold (mirrors backend build_smart_jump_segments).
 * @param {number[]} killTicks
 * @param {number} thresholdTicks
 * @returns {number[][]}
 */
function groupKillTicksByThreshold(killTicks, thresholdTicks) {
  const sorted = [...killTicks]
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

// Backend defaults that the frontend can't derive from pacing_override alone.
// victim_pov_pre falls back to highlight_pre_sec (3.0) when not overridden;
// victim_pov_post and fail_killer pre/post come from RecordingOptions defaults.
const _VICTIM_POV_PRE_DEFAULT = 3.0;
const _VICTIM_POV_POST_DEFAULT = 1.5;
const _KILLER_POV_PRE_DEFAULT = 1.5; // buildDtoFromQueueItem fallback chain
const _KILLER_POV_POST_DEFAULT = 1.5;

/**
 * 估算单条入 OBS 的输出视频时长（秒）。
 *
 * 路径一（kill_ticks 可用）：按 max_gap_sec 分组，每组 = (last-first)/64 + pre + post。
 * 路径二（source_ticks 合集）：各段跨度之和 + N × (pre + post)。
 * 路径三（兜底）：(end_tick - start_tick)/64，不额外叠加 pre/post（已含于 parser 输出的 tick 窗口中）。
 *
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {Record<string, unknown>} globalPacing
 */
export function estimateItemRecordSeconds(item, globalPacing) {
  const clip = item.clipData || {};
  const po = item.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const gp = globalPacing && typeof globalPacing === "object" ? globalPacing : {};
  const { pre_first_sec, post_last_sec, max_gap_sec } = mergedPacingForItem(item, globalPacing);
  let pre = Math.max(0.5, pre_first_sec);
  let post = Math.max(0.5, post_last_sec);
  const thresholdTicks = max_gap_sec * DEMO_TICK_RATE;

  // 时间线击杀：后端用 timeline_kill_pre_sec(3.0) / timeline_kill_post_sec(2.0)，
  // 与 BACKEND_DEFAULT_PACING(2/1) 不同。若用户未显式配置 pacing，改用后端真实默认值。
  const isTimelineKillEvent =
    String(clip.timeline_source || "") === "round_timeline_event" &&
    String(clip.timeline_record_kind || "") === "kill";
  if (isTimelineKillEvent) {
    if (po.pre_first_sec == null && gp.pre_first_sec == null) pre = 3.0;
    if (po.post_last_sec == null && gp.post_last_sec == null) post = 2.0;
  }

  const compilationKind = String(clip.compilation_kind || "");
  const isKillCompilation = compilationKind === "rival_kills" || compilationKind === "all_kills";
  const sourceTicks = clip.source_ticks;
  const killTicks = Array.isArray(clip.kill_ticks)
    ? clip.kill_ticks.filter((t) => Number.isFinite(Number(t)))
    : [];

  let sec = 0;

  if (isKillCompilation && Array.isArray(sourceTicks) && sourceTicks.length > 0) {
    // 路径二：合集 — 累加各段原始 tick 跨度，每段各加一份 pre+post
    let spans = 0;
    for (const p of sourceTicks) {
      if (Array.isArray(p) && p.length >= 2) {
        const a = Number(p[0]);
        const b = Number(p[1]);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
          spans += (b - a) / DEMO_TICK_RATE;
        }
      }
    }
    const N = sourceTicks.length;
    sec = spans + N * (pre + post);
  } else if (killTicks.length > 0) {
    // 路径一：按阈值分组 kill_ticks，每组 = span + pre + post
    const groups = groupKillTicksByThreshold(killTicks, thresholdTicks);
    for (const group of groups) {
      const span = (group[group.length - 1] - group[0]) / DEMO_TICK_RATE;
      sec += span + pre + post;
    }
  } else {
    // 路径三：兜底 — tick 窗口已含 parser 的 pre/post，直接用
    const st = Number(clip.start_tick);
    const et = Number(clip.end_tick);
    if (Number.isFinite(st) && Number.isFinite(et) && et > st) {
      sec = (et - st) / DEMO_TICK_RATE;
    } else {
      const kc = Number(clip.kill_count);
      sec = Number.isFinite(kc) && kc > 0 ? Math.max(4, kc * 5 + pre + post) : 12;
    }
  }

  // POV 追加：每杀一个 victim POV 段，killer POV 只有一段
  if (po.victim_pov) {
    const killCount = Math.max(1, killTicks.length || Number(clip.kill_count) || 1);
    const povPre = po.victim_pov_pre_sec ?? _VICTIM_POV_PRE_DEFAULT;
    const povPost = po.victim_pov_post_sec ?? _VICTIM_POV_POST_DEFAULT;
    sec += killCount * (povPre + povPost);
  }
  if (po.killer_pov) {
    const kPre = po.killer_pov_pre_sec ?? po.victim_pov_pre_sec ?? _KILLER_POV_PRE_DEFAULT;
    const kPost = po.killer_pov_post_sec ?? po.victim_pov_post_sec ?? _KILLER_POV_POST_DEFAULT;
    sec += kPre + kPost;
  }

  return Math.max(3, Math.round(sec));
}

/**
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue
 * @param {Record<string, unknown>} globalPacing
 */
export function estimateQueueTotalSeconds(queue, globalPacing) {
  if (!queue?.length) return 0;
  return queue.reduce((s, it) => s + estimateItemRecordSeconds(it, globalPacing), 0);
}

/** @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue */
export function countPovSegments(queue) {
  if (!queue?.length) return 0;
  let n = 0;
  for (const it of queue) {
    const po = it.pacing_override || {};
    if (po.victim_pov) n += 1;
    if (po.killer_pov) n += 1;
  }
  return n;
}

/** @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue */
export function uniqueDemoCount(queue) {
  if (!queue?.length) return 0;
  const set = new Set();
  for (const it of queue) {
    const k = it.demoFilename || it.demoPath || "";
    if (k) set.add(k);
  }
  return set.size;
}

/** @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue */
export function batchJobGroupCount(queue) {
  const byDemoPlayer = new Map();
  for (const it of queue) {
    const demoIdentity = it.demoPath || it.demoFilename;
    const key = `${demoIdentity}::${it.targetPlayer || ""}`;
    byDemoPlayer.set(key, true);
  }
  return byDemoPlayer.size;
}
