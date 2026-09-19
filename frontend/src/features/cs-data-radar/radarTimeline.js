/** 合辑时间线：数据雷达图候选项 / 占位段纯函数。 */

export const ANIMATION_DURATION_SEC = 4;
export const RADAR_ID_PREFIX = "radar:";

function trimStr(value) {
  return String(value ?? "").trim();
}

export function demoKeyFromClip(clip) {
  const path = trimStr(clip?.demo_path);
  if (path) return path;
  return trimStr(clip?.demo_filename);
}

export function playerKeyFromClip(clip) {
  const sid = trimStr(clip?.target_steamid64 || clip?.target_steam_id || clip?.steamid);
  const name = trimStr(clip?.player_name);
  if (sid && sid !== "0") return `sid:${sid}`;
  const normName = name.toLowerCase().replace(/\s+/g, "");
  return normName ? `name:${normName}` : "";
}

export function candidateKeyFromClip(clip) {
  const demo = demoKeyFromClip(clip);
  const player = playerKeyFromClip(clip);
  if (!demo || !player) return "";
  return `${demo}::${player}`;
}

export function deriveRadarCandidatesFromClips(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const map = new Map();
  for (const clip of clips) {
    const key = candidateKeyFromClip(clip);
    if (!key) continue;
    const sid = trimStr(clip?.target_steamid64 || clip?.target_steam_id || clip?.steamid);
    const name = trimStr(clip?.player_name);
    const existing = map.get(key);
    if (existing) {
      existing.segment_count += 1;
      if (name) existing.player_name = name;
      continue;
    }
    map.set(key, {
      key,
      demo_path: trimStr(clip?.demo_path),
      demo_filename: trimStr(clip?.demo_filename),
      demo_id: clip?.demo_id ?? null,
      player_key: playerKeyFromClip(clip),
      player_name: name,
      steamid64: sid && sid !== "0" ? sid : null,
      segment_count: 1,
    });
  }
  return [...map.values()];
}

export function makeRadarTimelineId(uid) {
  const raw = trimStr(uid);
  if (!raw) return `${RADAR_ID_PREFIX}${Date.now()}`;
  return raw.startsWith(RADAR_ID_PREFIX) ? raw : `${RADAR_ID_PREFIX}${raw}`;
}

export function isRadarTimelineId(id) {
  return typeof id === "string" && id.startsWith(RADAR_ID_PREFIX);
}

export function clipIdsFromTimeline(orderedIds) {
  const out = [];
  for (const id of orderedIds || []) {
    if (isRadarTimelineId(id)) continue;
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

export function insertRelativeTo(orderedIds, newId, { beforeId, afterId } = {}) {
  const next = [...(orderedIds || [])];
  if (beforeId != null) {
    const idx = next.findIndex((id) => String(id) === String(beforeId));
    if (idx >= 0) {
      next.splice(idx, 0, newId);
      return next;
    }
  }
  if (afterId != null) {
    const idx = next.findIndex((id) => String(id) === String(afterId));
    if (idx >= 0) {
      next.splice(idx + 1, 0, newId);
      return next;
    }
  }
  next.push(newId);
  return next;
}

function segmentBeforeClipId(seg) {
  const raw = seg?.before_clip_id ?? seg?.beforeClipId;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function migrateRadarSegmentsIntoTimeline(orderedClipIds, radarSegments) {
  const orderedIds = [...(orderedClipIds || [])];
  const radarItems = {};
  const grouped = new Map();
  for (const seg of radarSegments || []) {
    const beforeId = segmentBeforeClipId(seg);
    if (beforeId == null) continue;
    const list = grouped.get(beforeId) || [];
    list.push(seg);
    grouped.set(beforeId, list);
  }
  for (const [beforeId, segs] of grouped) {
    const clipIndex = orderedIds.findIndex((id) => Number(id) === Number(beforeId));
    if (clipIndex < 0) continue;
    const insertAt = clipIndex;
    segs.forEach((seg, offset) => {
      const uid = trimStr(seg.uid || seg.id) || `legacy-${beforeId}-${offset}`;
      const radarId = makeRadarTimelineId(uid);
      const duration = Number(seg.duration);
      radarItems[radarId] = {
        id: radarId,
        candidateKey: trimStr(seg.candidate_key || seg.candidateKey),
        playerName: trimStr(seg.player_name || seg.playerName),
        duration: Number.isFinite(duration) && duration > 0 ? duration : ANIMATION_DURATION_SEC,
      };
      orderedIds.splice(insertAt + offset, 0, radarId);
    });
  }
  return { orderedIds, radarItems };
}

export function exportTimelineIds(orderedIds, { radarEnabled } = {}) {
  if (radarEnabled) return [...(orderedIds || [])];
  return (orderedIds || []).filter((id) => !isRadarTimelineId(id));
}

export function radarInstanceDurationPlan(instanceDuration, baseDuration = ANIMATION_DURATION_SEC) {
  const output = Math.max(0.1, Number(instanceDuration) || baseDuration);
  const base = Math.max(0.1, Number(baseDuration) || ANIMATION_DURATION_SEC);
  const eps = 0.02;
  let mode = "exact";
  if (output > base + eps) mode = "pad";
  else if (output < base - eps) mode = "trim";
  return { mode, sourceDuration: base, outputDuration: output };
}

export function isCandidateOnTimeline(candidateKey, clips) {
  if (!candidateKey) return false;
  return (clips || []).some((clip) => candidateKeyFromClip(clip) === candidateKey);
}

export function timelineIdEqual(a, b) {
  return String(a) === String(b);
}

export function parseTimelineDragId(raw) {
  const s = trimStr(raw);
  if (!s) return null;
  if (isRadarTimelineId(s)) return s;
  const n = Number(s);
  if (Number.isInteger(n) && n > 0) return n;
  return null;
}

export function sortTimelineKeepingRadar(orderedIds, sortedClipIds) {
  const prefixes = new Map();
  const trailing = [];
  let pending = [];
  for (const id of orderedIds || []) {
    if (isRadarTimelineId(id)) {
      pending.push(id);
      continue;
    }
    prefixes.set(id, pending);
    pending = [];
  }
  trailing.push(...pending);
  const next = [];
  const seen = new Set();
  for (const clipId of sortedClipIds || []) {
    next.push(...(prefixes.get(clipId) || []));
    next.push(clipId);
    seen.add(clipId);
  }
  for (const [clipId, radars] of prefixes) {
    if (!seen.has(clipId)) next.push(...radars);
  }
  next.push(...trailing);
  return next;
}

function radarItemFromMeta(id, meta) {
  const duration = Number(meta?.duration);
  return {
    id,
    candidateKey: trimStr(meta?.candidate_key || meta?.candidateKey),
    playerName: trimStr(meta?.player_name || meta?.playerName),
    duration: Number.isFinite(duration) && duration > 0 ? duration : ANIMATION_DURATION_SEC,
  };
}

export function hydrateTimelineFromDraft({
  recordedClipIds,
  timelineIds,
  radarSegments,
  radarItems,
  availableClipIds,
} = {}) {
  const available = new Set((availableClipIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const srcItems = radarItems && typeof radarItems === "object" && !Array.isArray(radarItems) ? radarItems : {};
  if (Array.isArray(timelineIds) && timelineIds.length) {
    const orderedIds = [];
    const items = {};
    for (const raw of timelineIds) {
      if (isRadarTimelineId(raw) || (typeof raw === "string" && raw.startsWith(RADAR_ID_PREFIX))) {
        const id = makeRadarTimelineId(raw);
        orderedIds.push(id);
        items[id] = radarItemFromMeta(id, srcItems[id] || srcItems[raw] || {});
        continue;
      }
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && available.has(n)) orderedIds.push(n);
    }
    return { orderedIds, radarItems: items };
  }
  const clipIds = (recordedClipIds || [])
    .map((value) => Number(value))
    .filter((n) => Number.isInteger(n) && n > 0 && available.has(n));
  if (Array.isArray(radarSegments) && radarSegments.length) {
    return migrateRadarSegmentsIntoTimeline(clipIds, radarSegments);
  }
  return { orderedIds: clipIds, radarItems: {} };
}
