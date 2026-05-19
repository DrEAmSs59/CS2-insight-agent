import { stripGlobalPacingMetaKeys, BACKEND_DEFAULT_PACING } from "../stores/recordingQueueStore";
import { stripClientClipUid } from "./clipClientUid";
import { buildDtoFromQueueItem } from "../recording/buildDtoFromQueueItem";

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
    // Always include BACKEND_DEFAULT_PACING so that UI display values (which fall back to these)
    // are actually sent to the backend even when the user hasn't explicitly moved a slider.
    // User-set globalPacing keys override the defaults; per-clip pacing_override wins over both.
    const baseGlobal = {
      ...BACKEND_DEFAULT_PACING,
      ...stripGlobalPacingMetaKeys(globalPacing),
    };
    const mergedPacing = {
      ...baseGlobal,
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

/**
 * 从当前已解析场次中解析队列项的 match_meta（供 RecordingRequestDTO）。
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {unknown[]} uploadedDemos
 * @param {unknown[]} parsedMatches
 */
export function resolveMatchMetaForQueueItem(item, uploadedDemos, parsedMatches) {
  const df = String(item.demoFilename || "").trim();
  const dp = String(item.demoPath || "").trim();
  const n = parsedMatches?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const pm = parsedMatches[i];
    const um = uploadedDemos?.[i];
    const pmDf = String(pm?.demo_filename ?? um?.filename ?? "").trim();
    const pmDp = String(pm?.demo_path ?? um?.path ?? "").trim();
    const demoMatch =
      (dp && pmDp && dp === pmDp) ||
      (df && pmDf && df === pmDf) ||
      (df && pmDf && df.toLowerCase() === pmDf.toLowerCase());
    if (!demoMatch) continue;
    const tp = String(item.targetPlayer || "").trim();
    const pdata = pm?.players?.[tp];
    if (pdata) return pdata.match_meta ?? um?.match_meta ?? null;
    const players = pm?.players;
    if (players && typeof players === "object" && !Array.isArray(players)) {
      const first = Object.values(players)[0];
      if (first && typeof first === "object") return first.match_meta ?? um?.match_meta ?? null;
    }
    return um?.match_meta ?? null;
  }
  return null;
}

/**
 * [Recording V3] 将录制队列转为 POST /api/recording/queue 的 requests 数组。
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue
 * @param {import("../stores/recordingQueueStore").PacingOverride} globalPacing
 * @param {unknown[]} uploadedDemos
 * @param {unknown[]} parsedMatches
 */
export function buildRecordingQueueRequestsFromQueue(queue, globalPacing, uploadedDemos, parsedMatches) {
  const baseGlobal = {
    ...BACKEND_DEFAULT_PACING,
    ...stripGlobalPacingMetaKeys(globalPacing || {}),
  };
  const requests = [];
  for (const it of queue) {
    const mm = resolveMatchMetaForQueueItem(it, uploadedDemos, parsedMatches);
    const dto = buildDtoFromQueueItem(it, mm, baseGlobal);
    if (dto) requests.push(dto);
  }
  return requests;
}

/**
 * 将录制前弹窗中的 OBS 转场写入各 request.options（仅本次队列，不写配置）。
 * @param {object[]} requests
 * @param {{ obs_transition_enabled?: boolean | null, obs_transition_name?: string | null, obs_transition_duration_ms?: number | null }} session
 */
export function applySessionObsTransitionToRequests(requests, session) {
  if (!Array.isArray(requests) || !requests.length || !session) return requests;
  const { obs_transition_enabled: enabled, obs_transition_name: name, obs_transition_duration_ms: ms } =
    session;
  const patch = {};
  if (enabled !== undefined && enabled !== null) patch.obs_transition_enabled = !!enabled;
  if (name != null && name !== "") patch.obs_transition_name = name;
  if (ms != null && ms !== "" && Number.isFinite(Number(ms))) {
    patch.obs_transition_duration_ms = Number(ms);
  }
  if (!Object.keys(patch).length) return requests;
  return requests.map((r) => ({
    ...r,
    options: { ...(r.options || {}), ...patch },
  }));
}
