import { stripGlobalPacingMetaKeys, BACKEND_DEFAULT_PACING, useRecordingQueue } from "../stores/recordingQueueStore";
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
 * 同时搜索 Demo 库条目（demoLibraryItems），解决从库页加入队列时 all_players 为空的问题。
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem} item
 * @param {unknown[]} uploadedDemos
 * @param {unknown[]} parsedMatches
 * @param {unknown[]} [demoLibraryItems]
 */
export function resolveMatchMetaForQueueItem(item, uploadedDemos, parsedMatches, demoLibraryItems) {
  // 队列项自身携带了 match_meta 时直接优先使用。
  if (item?.matchMeta && typeof item.matchMeta === "object") return item.matchMeta;

  const df = String(item.demoFilename || "").trim();
  const dp = String(item.demoPath || "").trim();
  const tp = String(item.targetPlayer || "").trim();

  // 1. 优先搜索 Analysis 标签页的已解析场次（parsedMatches / uploadedDemos）
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
    const pdata = pm?.players?.[tp];
    if (pdata) return pdata.match_meta ?? um?.match_meta ?? null;
    const players = pm?.players;
    if (players && typeof players === "object" && !Array.isArray(players)) {
      const first = Object.values(players)[0];
      if (first && typeof first === "object") return first.match_meta ?? um?.match_meta ?? null;
    }
    return um?.match_meta ?? null;
  }

  // 2. 搜索 Demo 库条目（从库页加入队列，parsedMatches 中没有对应数据）
  const libItems = demoLibraryItems;
  if (Array.isArray(libItems)) {
    for (const lib of libItems) {
      const libDf = String(lib?.filename || "").trim();
      const libDp = String(lib?.path || "").trim();
      const demoMatch =
        (dp && libDp && dp === libDp) ||
        (df && libDf && df === libDf) ||
        (df && libDf && df.toLowerCase() === libDf.toLowerCase());
      if (!demoMatch) continue;
      const result = lib?.result;
      if (!result) return null;
      // 优先从对应玩家条目取 match_meta，其次取第一个玩家，最后取根级 match_meta
      const players = result.players;
      if (players && typeof players === "object" && !Array.isArray(players)) {
        const pdata = players[tp];
        if (pdata?.match_meta) return pdata.match_meta;
        const first = Object.values(players)[0];
        if (first?.match_meta) return first.match_meta;
      }
      return result.match_meta ?? null;
    }
  }

  return null;
}

/**
 * [Recording V3] 将录制队列转为 POST /api/recording/queue 的 requests 数组。
 * @param {import("../stores/recordingQueueStore").RecordingQueueItem[]} queue
 * @param {import("../stores/recordingQueueStore").PacingOverride} globalPacing
 * @param {unknown[]} uploadedDemos
 * @param {unknown[]} parsedMatches
 * @param {unknown[]} [demoLibraryItems]
 */
export function buildRecordingQueueRequestsFromQueue(queue, globalPacing, uploadedDemos, parsedMatches, demoLibraryItems) {
  const baseGlobal = {
    ...BACKEND_DEFAULT_PACING,
    ...stripGlobalPacingMetaKeys(globalPacing || {}),
  };
  const requests = [];
  for (const it of queue) {
    const mm = resolveMatchMetaForQueueItem(it, uploadedDemos, parsedMatches, demoLibraryItems);
    const dto = buildDtoFromQueueItem(it, mm, baseGlobal);
    if (dto) requests.push(dto);
  }
  // 「回合时间线」开关：录制时按阈值合并间隔相近的击杀/死亡镜头（镜头类型仍为时间线）。
  if (useRecordingQueue.getState().mergeTimelineClipsEnabled) {
    const thresholdSec =
      Number(globalPacing?.max_gap_sec) ||
      BACKEND_DEFAULT_PACING.max_gap_sec ||
      12;
    const tickRate = Number(requests?.[0]?.demo?.tick_rate) || 64;
    return mergeTimelineRequestsForRecording(requests, { thresholdSec, tickRate });
  }
  return requests;
}

/**
 * 将「间隔相近」的时间线击杀/死亡请求合并为单条时间线请求（保持 timeline_kill/timeline_death 类型）。
 *
 * 分组规则（与击杀合集阈值一致，默认 12s）：
 * - 按 同一 demo + 目标玩家 + 地图 归组，按 (round, tick) 升序；
 * - 相邻请求同一 round 且 tick 间隔 ≤ thresholdTicks 时合并为一组；
 * - 组内含击杀 → 以 timeline_kill 为基座，聚合所有事件（含紧跟的死亡事件），
 *   后端把聚合 tick 聚为一段连续素材（击杀→迅速死亡连贯录制）；
 * - 组内仅死亡 → 以 timeline_death 为基座聚合。
 *
 * 合并请求的 `source_ref.queue_item_id` 保留首条队列项的 id，以便结果回填；
 * 全部成功后整队列清空，不影响结果一致性。
 *
 * @param {object[]} requests
 * @param {{ thresholdSec?: number, tickRate?: number }} [opts]
 * @returns {object[]}
 */
export function mergeTimelineRequestsForRecording(requests, { thresholdSec = 12, tickRate = 64 } = {}) {
  if (!Array.isArray(requests) || !requests.length) return requests;

  const thresholdTicks = Math.max(0, Math.round(Number(thresholdSec) * (Number(tickRate) || 64)));
  const timeline = [];
  const others = [];
  for (const req of requests) {
    const rt = String(req?.request_type || "");
    if (rt === "timeline_kill" || rt === "timeline_death") timeline.push(req);
    else others.push(req);
  }
  if (!timeline.length) return requests;

  const byKey = new Map();
  for (const req of timeline) {
    const key = `${req?.demo?.demo_filename || ""}::${req?.target_player?.name || ""}::${req?.demo?.map_name || ""}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(req);
  }

  const groups = [];
  for (const arr of byKey.values()) {
    arr.sort((a, b) => {
      const ra = Number(a?.events?.[0]?.round) || 0;
      const rb = Number(b?.events?.[0]?.round) || 0;
      if (ra !== rb) return ra - rb;
      return (Number(a?.events?.[0]?.tick) || 0) - (Number(b?.events?.[0]?.tick) || 0);
    });

    let cur = [];
    for (const req of arr) {
      if (!cur.length) {
        cur = [req];
        continue;
      }
      const prev = cur[cur.length - 1];
      const prevEv = prev?.events?.[0];
      const ev = req?.events?.[0];
      const sameRound = prevEv && ev && Number(prevEv.round) === Number(ev.round);
      const gap = prevEv && ev ? Number(ev.tick) - Number(prevEv.tick) : Number.NaN;
      if (sameRound && Number.isFinite(gap) && gap >= 0 && gap <= thresholdTicks) {
        cur.push(req);
      } else {
        groups.push(cur);
        cur = [req];
      }
    }
    if (cur.length) groups.push(cur);
  }

  const result = [];
  for (const group of groups) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      result.push(buildMergedTimelineRequest(group));
    }
  }
  return [...others, ...result];
}

/**
 * 将一组时间线请求合并为单条请求（保留时间线类型）。
 * @param {object[]} group 按 round,tick 升序的时间线请求（≥2）
 * @returns {object}
 */
function buildMergedTimelineRequest(group) {
  const firstKill = group.find((r) => String(r?.request_type || "") === "timeline_kill");
  const base = firstKill || group[0];
  const hasKill = Boolean(firstKill);
  const isKill = hasKill;

  // 聚合事件并按 tick 升序排列（击杀→死亡连贯）。
  const events = group
    .flatMap((r) => (Array.isArray(r?.events) ? r.events : []))
    .filter(Boolean)
    .sort((a, b) => Number(a?.tick || 0) - Number(b?.tick || 0));

  const sourceRef = { ...(base.source_ref || {}) };
  const mergedEventIds = group
    .map((r) => r?.source_ref?.timeline_event_id)
    .filter((v) => v != null && v !== "");
  if (mergedEventIds.length) {
    sourceRef.merged_timeline_event_ids = mergedEventIds;
  }

  return {
    ...base,
    request_type: isKill ? "timeline_kill" : "timeline_death",
    source_type: isKill ? "kill" : "death",
    events,
    source_ref: sourceRef,
    _merged_from: group.length,
  };
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
