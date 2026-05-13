import { BACKEND_DEFAULT_PACING } from "../stores/recordingQueueStore";
import {
  getClipDurationSeconds,
  getCompilationSourceTicksSpanSeconds,
} from "./montageUtils";

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
 * 粗算单条入 OBS 的素材时长（秒）：tick 跨度 / source_ticks 累加；每段含击杀前预留 + 击杀后预留；
 * 多段 smart jump-cut 时段间再各加一组（与后端分段一致）。含 POV 追加。
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {Record<string, unknown>} globalPacing
 */
export function estimateItemRecordSeconds(item, globalPacing) {
  const clip = item.clipData || {};
  const po = item.pacing_override && typeof item.pacing_override === "object" ? item.pacing_override : {};
  const { pre_first_sec, post_last_sec } = mergedPacingForItem(item, globalPacing);
  const pre = Math.max(0.5, pre_first_sec);
  const post = Math.max(0.5, post_last_sec);

  const kind = String(clip.compilation_kind || "");
  const src = clip.source_ticks;
  const spanFromSources = getCompilationSourceTicksSpanSeconds(clip);
  let core =
    spanFromSources != null && Number.isFinite(spanFromSources)
      ? spanFromSources
      : getClipDurationSeconds(clip);
  if (core == null || !Number.isFinite(core)) {
    const kc = Number(clip.kill_count);
    core = Number.isFinite(kc) && kc > 0 ? Math.max(4, kc * 5) : 12;
  }
  core = Math.max(0.5, core);

  let segmentCount = 1;
  if (Array.isArray(src) && src.length > 0 && (kind === "rival_kills" || kind === "all_kills")) {
    segmentCount = Math.max(1, src.length);
  }

  let sec = core + (segmentCount * 2 - 1) * (pre + post);

  if (po.victim_pov) sec += 14;
  if (po.killer_pov) sec += 14;

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
