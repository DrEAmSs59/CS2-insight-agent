import { stripGlobalPacingMetaKeys } from "../stores/recordingQueueStore";
import { stripClientClipUid } from "./clipClientUid";

export function queueItemClientUid(it) {
  return it.clientClipUid || `legacy:${it.demoFilename}:${it.clipId}`;
}

/** @param {number} limit @param {T[]} items @param {(item: T) => Promise<void>} work @template T */
export async function runWithConcurrency(limit, items, work) {
  if (!items.length) return;
  const n = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const my = cursor++;
      if (my >= items.length) break;
      await work(items[my]);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue
 * @param {import("../stores/recordingQueueStore").PacingOverride} globalPacing
 */
export function buildBatchGroupsFromQueue(queue, globalPacing = {}) {
  const byDemoPlayer = new Map();
  for (const it of queue) {
    const demoIdentity = it.demoPath || it.demoFilename;
    const key = `${demoIdentity}::${it.targetPlayer || ""}`;
    if (!byDemoPlayer.has(key)) {
      byDemoPlayer.set(key, {
        demo_filename: it.demoFilename,
        demo_path: it.demoPath || null,
        clips: [],
        target_player: it.targetPlayer || null,
        target_player_user_id: it.targetPlayerUserId ?? null,
        target_steam_id: it.targetSteamId || null,
      });
    }
    const clip = { ...stripClientClipUid(it.clipData) };
    const baseGlobal = stripGlobalPacingMetaKeys(globalPacing);
    const mergedPacing = {
      ...(Object.keys(baseGlobal).length ? baseGlobal : {}),
      ...(it.pacing_override && typeof it.pacing_override === "object" ? it.pacing_override : {}),
    };
    if (Object.keys(mergedPacing).length) {
      clip.pacing_override = mergedPacing;
    }
    if (clip.fixed_segment_pacing && clip.pacing_override && typeof clip.pacing_override === "object") {
      const deny = new Set([
        "pre_first_sec",
        "post_last_sec",
        "max_gap_sec",
        "post_mid_sec",
        "pre_cont_sec",
      ]);
      const po = { ...clip.pacing_override };
      for (const k of deny) delete po[k];
      if (Object.keys(po).length) clip.pacing_override = po;
      else delete clip.pacing_override;
    }
    byDemoPlayer.get(key).clips.push(clip);
  }
  return Array.from(byDemoPlayer.values());
}
