/** LiteCut timeline helpers — schema v2 aligned. */

import { normalizedOverlayKeyframes, overlayTransformAt, VIDEO_LAYER_TRANSFORM_DEFAULTS } from "./overlayKeyframeUtils.js";
import { rebaseAudioKeyframes } from "./audioKeyframeUtils.js";

export function newClipId() {
  return `clip-${crypto.randomUUID().slice(0, 12)}`;
}

export function clipSourceDuration(clip) {
  return clipTimelineDuration(clip);
}

export function clipPlaybackSpeed(clip) {
  const speed = Number(clip?.speed);
  return Number.isFinite(speed) && speed > 0 ? Math.max(0.25, Math.min(4, speed)) : 1;
}

export function normalizedClipSpeedKeyframes(clip) {
  const trimIn = Math.max(0, Number(clip?.trim_in) || 0);
  const trimOut = trimIn + clipTrimmedSourceDuration(clip);
  const fallback = clipPlaybackSpeed(clip);
  const points = [];
  for (const raw of clip?.speed_keyframes || []) {
    if (!raw || typeof raw !== "object") continue;
    const sourceSec = Number(raw.source_sec);
    const speed = Number(raw.speed);
    if (!Number.isFinite(sourceSec) || !Number.isFinite(speed)) continue;
    points.push({
      source_sec: Math.max(trimIn, Math.min(trimOut, sourceSec)),
      speed: Math.max(0.25, Math.min(4, speed)),
    });
  }
  points.sort((a, b) => a.source_sec - b.source_sec);
  const deduped = [];
  for (const point of points) {
    const index = deduped.findIndex((item) => Math.abs(item.source_sec - point.source_sec) < 0.0001);
    if (index >= 0) deduped[index] = point;
    else deduped.push(point);
  }
  if (deduped.length < 2) return [];
  if (deduped[0].source_sec > trimIn + 0.0001) deduped.unshift({ source_sec: trimIn, speed: fallback });
  if (deduped.at(-1).source_sec < trimOut - 0.0001) deduped.push({ source_sec: trimOut, speed: deduped.at(-1).speed });
  return deduped;
}

export function clipSpeedSegments(clip) {
  const trimIn = Math.max(0, Number(clip?.trim_in) || 0);
  const trimOut = trimIn + clipTrimmedSourceDuration(clip);
  const points = normalizedClipSpeedKeyframes(clip);
  if (!points.length) return [{ sourceStart: trimIn, sourceEnd: trimOut, speed: clipPlaybackSpeed(clip) }];
  return points.slice(0, -1).map((point, index) => ({
    sourceStart: point.source_sec,
    sourceEnd: points[index + 1].source_sec,
    speed: point.speed,
  })).filter((segment) => segment.sourceEnd - segment.sourceStart > 0.0001);
}

export function clipTimelineTimeForSource(clip, sourceSec) {
  const trimIn = Math.max(0, Number(clip?.trim_in) || 0);
  const source = Math.max(trimIn, Math.min(trimIn + clipTrimmedSourceDuration(clip), Number(sourceSec) || trimIn));
  let timeline = 0;
  for (const segment of clipSpeedSegments(clip)) {
    if (source <= segment.sourceStart) break;
    timeline += (Math.min(source, segment.sourceEnd) - segment.sourceStart) / segment.speed;
    if (source <= segment.sourceEnd) break;
  }
  return timeline;
}

export function clipSourceTimeForTimeline(clip, timelineSec) {
  const target = Math.max(0, Math.min(clipMediaTimelineDuration(clip), Number(timelineSec) || 0));
  let elapsed = 0;
  for (const segment of clipSpeedSegments(clip)) {
    const timelineLength = (segment.sourceEnd - segment.sourceStart) / segment.speed;
    if (target <= elapsed + timelineLength + 0.000001) {
      return segment.sourceStart + Math.max(0, target - elapsed) * segment.speed;
    }
    elapsed += timelineLength;
  }
  return Math.max(0, Number(clip?.trim_in) || 0) + clipTrimmedSourceDuration(clip);
}

export function clipSpeedAtTimeline(clip, timelineSec) {
  const source = clipSourceTimeForTimeline(clip, timelineSec);
  const segment = clipSpeedSegments(clip).find((item) => source >= item.sourceStart - 0.0001 && source <= item.sourceEnd + 0.0001);
  return segment?.speed ?? clipPlaybackSpeed(clip);
}

export function clipFreezeFrameSec(clip) {
  const freeze = Number(clip?.freeze_frame_sec);
  return Number.isFinite(freeze) ? Math.max(0, Math.min(30, freeze)) : 0;
}

export function clipReversePlayback(clip) {
  return Boolean(clip?.reverse);
}

export function clipPreservePitch(clip) {
  return clip?.preserve_pitch !== false;
}

export function clipCanvasFit(clip, fallback = "contain") {
  const raw = String(clip?.canvas_fit || "").toLowerCase();
  if (["contain", "cover", "blur"].includes(raw)) return raw;
  return ["contain", "cover", "blur"].includes(fallback) ? fallback : "contain";
}

export function clipTrimmedSourceDuration(clip) {
  if (!clip) return 5;
  const trimOut = clip.trim_out;
  const trimIn = Number(clip.trim_in) || 0;
  if (trimOut != null && Number.isFinite(Number(trimOut))) {
    return Math.max(0.1, Number(trimOut) - trimIn);
  }
  const meta = clip.meta;
  if (meta && Number.isFinite(Number(meta.duration_sec))) {
    return Math.max(0.1, Number(meta.duration_sec) - trimIn);
  }
  return 5;
}

export function clipMediaTimelineDuration(clip) {
  return Math.max(MIN_CLIP_VISIBLE_SEC, clipTimelineTimeForSource(clip, (Number(clip?.trim_in) || 0) + clipTrimmedSourceDuration(clip)));
}

export function clipTimelineDuration(clip) {
  return clipMediaTimelineDuration(clip) + clipFreezeFrameSec(clip);
}

/** 确保 meta.duration_sec 存在（仅首次回填，之后 trim 不可改源时长） */
export function ensureClipSourceDuration(clip) {
  if (!clip) return 5;
  if (!clip.meta || typeof clip.meta !== "object") clip.meta = {};
  const existing = Number(clip.meta.duration_sec);
  if (existing > 0) return existing;
  const trimIn = Number(clip.trim_in) || 0;
  const trimOut = Number(clip.trim_out);
  const inferred = trimOut > trimIn ? trimOut : trimIn + clipTrimmedSourceDuration(clip);
  clip.meta.duration_sec = Math.max(MIN_CLIP_VISIBLE_SEC, inferred);
  return clip.meta.duration_sec;
}

/** 源素材总时长（trim 不可超出此值；绝不读取可变 trim_out） */
export function clipSourceMediaDuration(clip) {
  if (!clip) return 5;
  const meta = clip.meta;
  if (meta && Number.isFinite(Number(meta.duration_sec)) && Number(meta.duration_sec) > 0) {
    return Number(meta.duration_sec);
  }
  return ensureClipSourceDuration(clip);
}

const MIN_CLIP_VISIBLE_SEC = 0.1;

/** 右缘裁剪：时间轴上允许的最晚结束时间 */
export function clipMaxTimelineEnd(clip) {
  const start = Number(clip.timeline_start) || 0;
  const sourceDur = clipSourceMediaDuration(clip);
  const extended = { ...clip, trim_out: sourceDur };
  return start + Math.max(MIN_CLIP_VISIBLE_SEC, clipTimelineTimeForSource(extended, sourceDur)) + clipFreezeFrameSec(clip);
}

/** 左缘裁剪：时间轴上允许的最晚起始时间（裁掉片头） */
export function clipMaxTimelineStartForLeftTrim(clip) {
  const start = Number(clip.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  const sourceDur = clipSourceMediaDuration(clip);
  const extended = { ...clip, trim_out: sourceDur };
  const maxFromSource = start + Math.max(0, clipTimelineTimeForSource(extended, sourceDur - MIN_CLIP_VISIBLE_SEC));
  return Math.min(end - MIN_CLIP_VISIBLE_SEC, maxFromSource);
}

export function clipTimelineEnd(clip) {
  return (Number(clip.timeline_start) || 0) + clipSourceDuration(clip);
}

/** 叠加层素材时长（视频/webm 用于裁剪上限） */
export function overlaySourceDuration(overlay) {
  const ov = overlay?._overlay || overlay;
  if (!ov) return 3;
  const meta = ov.meta || {};
  if (Number(meta.duration_sec) > 0) return Number(meta.duration_sec);
  const kind = meta.kind || ov.type;
  if (kind === "image" || kind === "sticker") return Math.max(0.1, Number(ov.duration) || 3);
  return Math.max(0.1, Number(ov.duration) || 5);
}

/** 叠加层右缘裁剪上限（视频/webm 不可超素材时长） */
export function overlayMaxTimelineEnd(overlay) {
  const ov = overlay?._overlay || overlay;
  const start = Number(ov?.timeline_start) || 0;
  const meta = ov?.meta || {};
  const kind = meta.kind || ov?.type;
  if (kind === "webm" || kind === "video" || ov?.type === "webm") {
    const trimIn = Number(ov.trim_in) || 0;
    return start + Math.max(MIN_CLIP_VISIBLE_SEC, overlaySourceDuration(overlay) - trimIn);
  }
  return start + Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov?.duration) || 3);
}

export function overlayTimelineEnd(overlay) {
  const ov = overlay?._overlay || overlay;
  return (Number(ov?.timeline_start) || 0) + Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov?.duration) || 0);
}

export function selectedTimelineRange(body, ids = []) {
  const wanted = new Set((ids || []).filter(Boolean).map(String));
  if (!wanted.size) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const ov of body?.overlays || []) {
    if (!wanted.has(String(ov?.id))) continue;
    start = Math.min(start, Math.max(0, Number(ov.timeline_start) || 0));
    end = Math.max(end, overlayTimelineEnd(ov));
  }
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      if (!wanted.has(String(clip?.id))) continue;
      start = Math.min(start, Math.max(0, Number(clip.timeline_start) || 0));
      end = Math.max(end, clipTimelineEnd(clip));
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { startSec: start, endSec: end };
}

export function resizeOverlayDraft(overlay, { start, duration }) {
  const ov = structuredClone(overlay);
  const oldStart = Number(ov.timeline_start) || 0;
  const oldDuration = Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov.duration) || 0);
  const requestedStart = start != null ? Math.max(0, Number(start) || 0) : null;
  const requestedDuration = duration != null ? Math.max(MIN_CLIP_VISIBLE_SEC, Number(duration) || 0) : null;
  const requestedEnd = requestedStart != null && requestedDuration != null ? requestedStart + requestedDuration : null;

  if (requestedStart != null) {
    let nextStart = requestedStart;
    if (overlayHasMediaDurationCap(ov)) {
      const oldTrim = Math.max(0, Number(ov.trim_in) || 0);
      const wantedTrim = oldTrim + (requestedStart - oldStart);
      const nextTrim = Math.max(0, wantedTrim);
      nextStart = oldStart + (nextTrim - oldTrim);
      ov.trim_in = nextTrim;
    }
    ov.timeline_start = Math.max(0, nextStart);
  }

  if (requestedDuration != null) {
    const startSec = Number(ov.timeline_start) || 0;
    const wantedDuration = requestedEnd != null ? requestedEnd - startSec : requestedDuration;
    if (overlayHasMediaDurationCap(ov)) {
      const maxEnd = overlayMaxTimelineEnd(ov);
      const maxDur = Math.max(MIN_CLIP_VISIBLE_SEC, maxEnd - startSec);
      ov.duration = Math.max(MIN_CLIP_VISIBLE_SEC, Math.min(wantedDuration, maxDur));
    } else {
      ov.duration = Math.max(MIN_CLIP_VISIBLE_SEC, wantedDuration);
    }
  }

  if (Array.isArray(overlay?.keyframes) && overlay.keyframes.length) {
    const shift = (Number(ov.timeline_start) || 0) - oldStart;
    const nextDuration = Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov.duration) || 0);
    const keyframes = normalizedOverlayKeyframes(overlay)
      .map((keyframe) => ({ ...keyframe, time_sec: keyframe.time_sec - shift }))
      .filter((keyframe) => keyframe.time_sec >= -0.0001 && keyframe.time_sec <= nextDuration + 0.0001);
    if (shift > 0 && shift < oldDuration) {
      keyframes.unshift({ time_sec: 0, transform: overlayTransformAt(overlay, oldStart + shift) });
    }
    const cutLocal = nextDuration + shift;
    if (cutLocal < oldDuration && normalizedOverlayKeyframes(overlay).some((keyframe) => keyframe.time_sec > cutLocal + 0.0001)) {
      keyframes.push({ time_sec: nextDuration, transform: overlayTransformAt(overlay, oldStart + cutLocal) });
    }
    ov.keyframes = normalizeOverlayKeyframesForDuration(keyframes, nextDuration);
  }

  return ov;
}

function normalizeOverlayKeyframesForDuration(keyframes, duration) {
  const out = [];
  for (const keyframe of keyframes) {
    const time_sec = Math.max(0, Math.min(duration, Number(keyframe?.time_sec) || 0));
    const existing = out.findIndex((item) => Math.abs(item.time_sec - time_sec) < 0.0001);
    const next = { ...keyframe, time_sec };
    if (existing >= 0) out[existing] = next;
    else out.push(next);
  }
  return out.sort((a, b) => a.time_sec - b.time_sec);
}

export function rebaseTimelineClipKeyframes(original, nextClip) {
  let result = nextClip;
  if (!Array.isArray(original?.keyframes) || !original.keyframes.length) return rebaseAudioKeyframes(original, result);
  const oldStart = Number(original.timeline_start) || 0;
  const oldDuration = clipTimelineDuration(original);
  const nextStart = Number(nextClip.timeline_start) || 0;
  const nextDuration = clipTimelineDuration(nextClip);
  const shift = nextStart - oldStart;
  const source = { ...original, duration: oldDuration };
  const keyframes = normalizedOverlayKeyframes(source, VIDEO_LAYER_TRANSFORM_DEFAULTS)
    .map((keyframe) => ({ ...keyframe, time_sec: keyframe.time_sec - shift }))
    .filter((keyframe) => keyframe.time_sec >= -0.0001 && keyframe.time_sec <= nextDuration + 0.0001);
  if (shift > 0 && shift < oldDuration) {
    keyframes.unshift({ time_sec: 0, transform: overlayTransformAt(source, oldStart + shift, VIDEO_LAYER_TRANSFORM_DEFAULTS) });
  }
  const cutLocal = nextDuration + shift;
  if (cutLocal < oldDuration && normalizedOverlayKeyframes(source, VIDEO_LAYER_TRANSFORM_DEFAULTS).some((keyframe) => keyframe.time_sec > cutLocal + 0.0001)) {
    keyframes.push({ time_sec: nextDuration, transform: overlayTransformAt(source, oldStart + cutLocal, VIDEO_LAYER_TRANSFORM_DEFAULTS) });
  }
  result = { ...nextClip, keyframes: normalizeOverlayKeyframesForDuration(keyframes, nextDuration) };
  return rebaseAudioKeyframes(original, result);
}

export function splitOverlayAt(overlay, localSec) {
  const ov = structuredClone(overlay);
  const duration = Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov.duration) || 0);
  const split = Math.max(MIN_CLIP_VISIBLE_SEC, Math.min(duration - MIN_CLIP_VISIBLE_SEC, Number(localSec) || 0));
  const left = { ...ov, duration: split };
  const right = {
    ...structuredClone(ov),
    id: newOverlayId(),
    timeline_start: (Number(ov.timeline_start) || 0) + split,
    duration: Math.max(MIN_CLIP_VISIBLE_SEC, duration - split),
  };
  if (overlayHasMediaDurationCap(ov)) {
    const trimIn = Number(ov.trim_in) || 0;
    right.trim_in = trimIn + split;
  }
  if (Array.isArray(ov.keyframes) && ov.keyframes.length) {
    const keyframes = normalizedOverlayKeyframes(ov);
    const splitTransform = overlayTransformAt(ov, (Number(ov.timeline_start) || 0) + split);
    left.keyframes = normalizeOverlayKeyframesForDuration(
      [...keyframes.filter((keyframe) => keyframe.time_sec < split - 0.0001), { time_sec: split, transform: splitTransform }],
      split,
    );
    right.keyframes = normalizeOverlayKeyframesForDuration(
      [{ time_sec: 0, transform: splitTransform }, ...keyframes.filter((keyframe) => keyframe.time_sec > split + 0.0001).map((keyframe) => ({ ...keyframe, time_sec: keyframe.time_sec - split }))],
      right.duration,
    );
  }
  return [left, right];
}

export function overlayHasMediaDurationCap(overlay) {
  const ov = overlay?._overlay || overlay;
  const meta = ov?.meta || {};
  const kind = meta.kind || ov?.type;
  return kind === "webm" || kind === "video" || ov?.type === "webm";
}

export function sortClips(clips) {
  return [...(clips || [])].sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0));
}

export function compactTrackGaps(track, { startAt = 0 } = {}) {
  const clips = sortClips(track?.clips || []);
  let cursor = Math.max(0, Number(startAt) || 0);
  let changed = false;
  const next = clips.map((clip) => {
    const currentStart = Math.max(0, Number(clip.timeline_start) || 0);
    const nextStart = cursor;
    const out = Math.abs(currentStart - nextStart) > 1e-6 ? { ...clip, timeline_start: nextStart } : clip;
    if (out !== clip) changed = true;
    cursor = nextStart + clipSourceDuration(out);
    return out;
  });
  return { changed, clips: next };
}

export function getTrack(body, trackId) {
  return body?.tracks?.find((t) => t.id === trackId) || null;
}

export function videoTracks(body) {
  return (body?.tracks || []).filter((t) => t.type === "video");
}

export function editableVideoTracks(body) {
  return videoTracks(body).filter((t) => !t.hidden && !t.locked);
}

export function editableAudioTracks(body) {
  return audioTracks(body).filter((t) => !t.hidden && !t.locked);
}

/** UI 与落点计算共用：仅 V1 + 有片段的视频轨 */
export function visibleVideoTracks(body) {
  return videoTracks(body);
}

export function audioTracks(body) {
  return (body?.tracks || []).filter((t) => t.type === "audio");
}

export function newAudioTrackId() {
  return `a-${crypto.randomUUID().slice(0, 8)}`;
}

export function renumberAudioTrackLabels(tracks) {
  let n = 1;
  for (const t of tracks) {
    if (t.type === "audio") t.label = `A${n++}`;
  }
}

export function newVideoTrackId() {
  return `v-${crypto.randomUUID().slice(0, 8)}`;
}

export function renumberVideoTrackLabels(tracks) {
  let n = 1;
  for (const t of tracks) {
    if (t.type === "video") t.label = `V${n++}`;
  }
}

/** 在 afterTrackId 之后插入空视频轨，返回新轨 id */
export function insertVideoTrack(body, afterTrackId = null) {
  const tracks = [...(body.tracks || [])];
  const newTrack = {
    id: newVideoTrackId(),
    type: "video",
    label: "V?",
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    volume: 1,
    clips: [],
  };
  if (afterTrackId) {
    const idx = tracks.findIndex((t) => t.id === afterTrackId);
    tracks.splice(idx >= 0 ? idx + 1 : tracks.length, 0, newTrack);
  } else {
    let insertAt = 0;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].type === "video") insertAt = i + 1;
    }
    tracks.splice(insertAt, 0, newTrack);
  }
  renumberVideoTrackLabels(tracks);
  body.tracks = tracks;
  return newTrack.id;
}

/** 在 beforeTrackId 之前插入空视频轨 */
export function insertVideoTrackBefore(body, beforeTrackId) {
  const tracks = [...(body.tracks || [])];
  const newTrack = {
    id: newVideoTrackId(),
    type: "video",
    label: "V?",
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    volume: 1,
    clips: [],
  };
  const idx = tracks.findIndex((t) => t.id === beforeTrackId);
  tracks.splice(idx >= 0 ? idx : 0, 0, newTrack);
  renumberVideoTrackLabels(tracks);
  body.tracks = tracks;
  return newTrack.id;
}

/** 叠加素材：无明确落点时新建视频轨（OpenCut 风格） */
export function placeAssetOnVideoTrack(body) {
  const videos = videoTracks(body);
  const anchor = videos[videos.length - 1]?.id || null;
  return insertVideoTrack(body, anchor);
}

export function v1Clips(body) {
  const track = getTrack(body, "v1");
  if (track?.hidden) return [];
  const all = sortClips(track?.clips || []);
  return all.filter((c) => c.source_type !== "file" && c.source_id != null);
}

export function insertAudioTrack(body, afterTrackId = null) {
  const tracks = [...(body.tracks || [])];
  const newTrack = {
    id: newAudioTrackId(),
    type: "audio",
    label: "A?",
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    clips: [],
  };
  if (afterTrackId) {
    const idx = tracks.findIndex((t) => t.id === afterTrackId);
    tracks.splice(idx >= 0 ? idx + 1 : tracks.length, 0, newTrack);
  } else {
    let insertAt = tracks.length;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].type === "audio") insertAt = i + 1;
    }
    tracks.splice(insertAt, 0, newTrack);
  }
  renumberAudioTrackLabels(tracks);
  body.tracks = tracks;
  return newTrack.id;
}

export function canRemoveTrack(body, trackId) {
  const track = getTrack(body, trackId);
  if (!track || track.locked) return false;
  if ((track.clips || []).length > 0) return false;
  if (track.type === "video") return videoTracks(body).length > 1;
  if (track.type === "audio") return audioTracks(body).length > 1;
  return false;
}

export function removeTrackById(body, trackId) {
  if (!canRemoveTrack(body, trackId)) return false;
  body.tracks = (body.tracks || []).filter((t) => t.id !== trackId);
  renumberVideoTrackLabels(body.tracks);
  renumberAudioTrackLabels(body.tracks);
  return true;
}

export function canMoveTrackById(body, trackId, direction) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  const sourceIndex = tracks.findIndex((track) => track?.id === trackId);
  const source = tracks[sourceIndex];
  const step = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!source || !step || (source.type !== "video" && source.type !== "audio")) return false;
  for (let index = sourceIndex + step; index >= 0 && index < tracks.length; index += step) {
    if (tracks[index]?.type === source.type) return true;
  }
  return false;
}

export function moveTrackById(body, trackId, direction) {
  if (!canMoveTrackById(body, trackId, direction)) return false;
  const tracks = [...body.tracks];
  const sourceIndex = tracks.findIndex((track) => track?.id === trackId);
  const source = tracks[sourceIndex];
  const step = direction === "up" ? -1 : 1;
  let targetIndex = sourceIndex + step;
  while (tracks[targetIndex]?.type !== source.type) targetIndex += step;
  [tracks[sourceIndex], tracks[targetIndex]] = [tracks[targetIndex], tracks[sourceIndex]];
  body.tracks = tracks;
  return true;
}

export function canMoveTrackToId(body, trackId, targetTrackId, position = "before") {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  const source = tracks.find((track) => track?.id === trackId);
  const target = tracks.find((track) => track?.id === targetTrackId);
  if (!source || !target || source.id === target.id || source.type !== target.type) return false;
  if ((source.type !== "video" && source.type !== "audio") || (position !== "before" && position !== "after")) return false;

  const sameType = tracks.filter((track) => track.type === source.type);
  const sourceIndex = sameType.findIndex((track) => track.id === source.id);
  const reordered = [...sameType];
  const [lifted] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex((track) => track.id === target.id);
  reordered.splice(targetIndex + (position === "after" ? 1 : 0), 0, lifted);
  return reordered.some((track, index) => track.id !== sameType[index]?.id);
}

export function moveTrackToId(body, trackId, targetTrackId, position = "before") {
  if (!canMoveTrackToId(body, trackId, targetTrackId, position)) return false;
  const tracks = [...body.tracks];
  const source = tracks.find((track) => track?.id === trackId);
  const typeSlots = tracks
    .map((track, index) => (track.type === source.type ? index : -1))
    .filter((index) => index >= 0);
  const sameType = typeSlots.map((index) => tracks[index]);
  const sourceIndex = sameType.findIndex((track) => track.id === trackId);
  const [lifted] = sameType.splice(sourceIndex, 1);
  const targetIndex = sameType.findIndex((track) => track.id === targetTrackId);
  sameType.splice(targetIndex + (position === "after" ? 1 : 0), 0, lifted);
  typeSlots.forEach((slot, index) => {
    tracks[slot] = sameType[index];
  });
  body.tracks = tracks;
  return true;
}

export function v1AllClips(body) {
  const track = getTrack(body, "v1");
  if (track?.hidden) return [];
  return sortClips(track?.clips || []);
}

const MAIN_VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

export function isMainFileVideoClip(clip) {
  if (clip?.source_type !== "file") return false;
  return MAIN_VIDEO_EXT_RE.test(String(clip.file_path || ""));
}

export function canTrimTimelineClip(clip, trackType) {
  if (!clip) return false;
  if (trackType === "audio") return true;
  if (trackType !== "video") return false;
  if (clip.source_type !== "file") return true;
  const meta = clip.meta || {};
  return meta.kind === "video" || isMainFileVideoClip(clip);
}

export function canTrimClipStartToPlayhead(clip, trackType, playheadSec) {
  if (!canTrimTimelineClip(clip, trackType)) return false;
  const t = Math.max(0, Number(playheadSec) || 0);
  const start = Number(clip?.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  return t > start + 0.05 && t < end - 0.05 && t <= clipMaxTimelineStartForLeftTrim(clip) + 1e-6;
}

export function canTrimClipEndToPlayhead(clip, trackType, playheadSec) {
  if (!canTrimTimelineClip(clip, trackType)) return false;
  const t = Math.max(0, Number(playheadSec) || 0);
  const start = Number(clip?.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  return t > start + 0.05 && t < end - 0.05 && t <= clipMaxTimelineEnd(clip) + 1e-6;
}

export function canTrimOverlayToPlayhead(overlay, side, playheadSec) {
  if (!overlay) return false;
  const t = Math.max(0, Number(playheadSec) || 0);
  const start = Number(overlay.timeline_start) || 0;
  const end = overlayTimelineEnd(overlay);
  if (side === "start") return t > start + 0.05 && t < end - 0.05;
  if (side === "end") return t > start + 0.05 && t < end - 0.05 && t <= overlayMaxTimelineEnd(overlay) + 1e-6;
  return false;
}

export function v1MainClips(body) {
  return v1AllClips(body).filter((c) => (c.source_type !== "file" && c.source_id != null) || isMainFileVideoClip(c));
}

export function trackMainVideoClips(track) {
  return sortClips(track?.clips || []).filter(
    (c) => (c.source_type !== "file" && c.source_id != null) || isMainFileVideoClip(c),
  );
}

export function mainVideoClips(body) {
  for (const track of videoTracks(body)) {
    if (track.hidden) continue;
    const clips = trackMainVideoClips(track);
    if (clips.length) return clips;
  }
  return [];
}

export function v2Clips(body) {
  return sortClips(getTrack(body, "v2")?.clips || []);
}

export function timelineTotalSec(body, minSec = 30) {
  let maxEnd = 0;
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      maxEnd = Math.max(maxEnd, clipTimelineEnd(clip));
    }
  }
  for (const ov of body?.overlays || []) {
    const end = (Number(ov.timeline_start) || 0) + (Number(ov.duration) || 0);
    maxEnd = Math.max(maxEnd, end);
  }
  for (const marker of body?.markers || []) {
    maxEnd = Math.max(maxEnd, Number(marker?.time_sec) || 0);
  }
  return Math.max(maxEnd, minSec);
}

export function clipLabel(clip) {
  if (!clip) return "片段";
  const meta = clip.meta;
  if (meta?.name && clip.source_type === "file") {
    return String(meta.name).slice(0, 20);
  }
  if (meta?.player_name) {
    const map = meta.map_name || meta.map || "";
    const short = map ? String(map).replace(/^de_/, "") : "";
    return [short, meta.player_name].filter(Boolean).join(" · ").slice(0, 20);
  }
  if (clip.source_id != null) return `#${clip.source_id}`;
  return clip.id?.slice(0, 12) || "片段";
}

export function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

export function canPlaceOnTrack(clips, start, duration, excludeId = null) {
  const end = start + duration;
  for (const c of clips || []) {
    if (excludeId && c.id === excludeId) continue;
    const cStart = Number(c.timeline_start) || 0;
    const cEnd = clipTimelineEnd(c);
    if (overlaps(start, end, cStart, cEnd)) return false;
  }
  return true;
}

export function nextAppendStart(clips) {
  if (!clips?.length) return 0;
  return Math.max(...clips.map(clipTimelineEnd));
}

export function findClipById(body, clipId) {
  if (!clipId || !body?.tracks) return { trackId: null, clip: null };
  for (const track of body.tracks) {
    const clip = (track.clips || []).find((c) => String(c.id) === String(clipId));
    if (clip) return { trackId: track.id, clip };
  }
  return { trackId: null, clip: null };
}

/**
 * Resolve the audible clip edited by audio controls. For a linked pair this
 * must be the A-track clip even when the video side is the primary selection.
 */
export function resolveAudioEditingTarget(body, clipId, trackId = null) {
  const preferredTrack = getTrack(body, trackId);
  const preferredClip = (preferredTrack?.clips || []).find((clip) => String(clip.id) === String(clipId));
  const direct = preferredClip ? { clip: preferredClip, trackId: preferredTrack.id } : findClipById(body, clipId);
  const directTrack = getTrack(body, direct.trackId);
  if (!direct.clip || directTrack?.type !== "video") return direct;

  const linkedAudioId = direct.clip.meta?.linked_audio_clip_id;
  if (!linkedAudioId) return direct;
  const linked = findClipById(body, linkedAudioId);
  return getTrack(body, linked.trackId)?.type === "audio" && linked.clip ? linked : direct;
}

/** Map schema clip → timeline UI block */
export function toTimelineBlock(clip, { selected = false, thumb = "from-orange-900 via-stone-800 to-zinc-900" } = {}) {
  const start = Number(clip.timeline_start) || 0;
  const width = clipSourceDuration(clip);
  return {
    id: clip.id,
    label: clipLabel(clip),
    start,
    width,
    thumb,
    selected,
    _clip: clip,
  };
}

export function buildRecordedClip(mediaItem, timelineStart) {
  const dur = Number(mediaItem?.duration) > 0 ? Number(mediaItem.duration) : 5;
  const meta =
    mediaItem?._raw && typeof mediaItem._raw === "object"
      ? { ...mediaItem._raw, duration_sec: Number(mediaItem?.duration) > 0 ? Number(mediaItem.duration) : mediaItem._raw.duration_sec }
      : { duration_sec: dur };
  return {
    id: newClipId(),
    source_type: "recorded_clip",
    source_id: mediaItem.id,
    timeline_start: timelineStart,
    trim_in: 0,
    trim_out: dur,
    transition_out: { type: "fade", duration_sec: 0.4 },
    color: { brightness: 0, contrast: 0, saturation: 0, filter_preset: null },
    canvas_fit: null,
    flip_horizontal: false,
    flip_vertical: false,
    speed: 1,
    speed_keyframes: [],
    preserve_pitch: true,
    reverse: false,
    freeze_frame_sec: 0,
    volume: 1,
    muted: false,
    fade_in_sec: 0,
    fade_out_sec: 0,
    meta,
  };
}

export function buildAssetClip(assetItem, timelineStart) {
  const dur =
    Number(assetItem?.duration_sec) > 0
      ? Number(assetItem.duration_sec)
      : assetItem?.kind === "image"
        ? 3
        : 5;
  return {
    id: newClipId(),
    source_type: "file",
    file_path: assetItem.path || assetItem.file_path,
    timeline_start: timelineStart,
    trim_in: 0,
    trim_out: dur,
    transition_out: null,
    color: null,
    canvas_fit: null,
    flip_horizontal: false,
    flip_vertical: false,
    speed: 1,
    speed_keyframes: [],
    preserve_pitch: true,
    reverse: false,
    freeze_frame_sec: 0,
    volume: 1,
    muted: false,
    fade_in_sec: 0,
    fade_out_sec: 0,
    meta: {
      asset_id: assetItem.id,
      name: assetItem.name,
      kind: assetItem.kind,
      duration_sec: dur,
      source_width: Number(assetItem.width) || null,
      source_height: Number(assetItem.height) || null,
      source_fps: Number(assetItem.fps) || null,
      codec_name: assetItem.codec_name || null,
      preview_proxy_version: assetItem.preview_proxy_version || null,
      has_alpha: Boolean(assetItem.has_alpha),
    },
  };
}

export function clipAudioSourcePath(clip) {
  if (!clip) return "";
  if (clip.source_type === "file" && clip.file_path) return String(clip.file_path);
  const meta = clip.meta && typeof clip.meta === "object" ? clip.meta : {};
  return String(meta.output_path || meta.file_path || meta.video_path || meta.clip_path || meta.path || "").trim();
}

export function canDetachClipAudio(clip, trackType = "video") {
  if (!clip || trackType !== "video") return false;
  const kind = String(clip.meta?.kind || "").toLowerCase();
  if (kind === "image" || kind === "font" || kind === "audio") return false;
  return Boolean(clipAudioSourcePath(clip));
}

export function buildDetachedAudioClip(clip, timelineStart = null) {
  if (!canDetachClipAudio(clip, "video")) return null;
  const path = clipAudioSourcePath(clip);
  const meta = clip.meta && typeof clip.meta === "object" ? clip.meta : {};
  const name = meta.name || meta.title || clipLabel(clip);
  const start = timelineStart != null ? Math.max(0, Number(timelineStart) || 0) : Number(clip.timeline_start) || 0;
  return {
    id: newClipId(),
    source_type: "file",
    source_id: clip.source_id ?? null,
    file_path: path,
    timeline_start: start,
    trim_in: Number(clip.trim_in) || 0,
    trim_out: clip.trim_out ?? meta.duration_sec ?? null,
    transition_out: null,
    color: null,
    speed: clipPlaybackSpeed(clip),
    speed_keyframes: structuredClone(clip.speed_keyframes || []),
    preserve_pitch: clipPreservePitch(clip),
    reverse: clipReversePlayback(clip),
    freeze_frame_sec: clipFreezeFrameSec(clip),
    volume: Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1,
    muted: false,
    fade_in_sec: Number(clip.fade_in_sec) || 0,
    fade_out_sec: Number(clip.fade_out_sec) || 0,
    meta: {
      asset_id: meta.asset_id,
      source_clip_id: clip.id,
      name: `${name} Audio`,
      kind: "audio",
      duration_sec: meta.duration_sec,
      detached_from_video: true,
    },
  };
}

/** 返回拆分原声与源视频组成的可一起编辑的关联片段。 */
export function linkedTimelineClipIds(body, clipId) {
  const { clip } = findClipById(body, clipId);
  if (!clip) return [];
  const sourceId = String(clip.meta?.source_clip_id || clip.id);
  const ids = [];
  for (const track of body?.tracks || []) {
    for (const candidate of track?.clips || []) {
      if (String(candidate?.id) === sourceId || String(candidate?.meta?.source_clip_id || "") === sourceId) {
        ids.push(String(candidate.id));
      }
    }
  }
  return [...new Set(ids)];
}

export function isAssetMediaItem(item) {
  return item?.mediaKind === "asset";
}

export function newOverlayId() {
  return `ov-${crypto.randomUUID().slice(0, 12)}`;
}

export function newMarkerId() {
  return `mk-${crypto.randomUUID().slice(0, 12)}`;
}

export function sortedMarkers(body) {
  return [...(body?.markers || [])]
    .filter((m) => m && Number.isFinite(Number(m.time_sec)))
    .map((m) => ({
      ...m,
      time_sec: Math.max(0, Number(m.time_sec) || 0),
      label: String(m.label || ""),
      color: /^#[0-9a-f]{6}$/i.test(String(m.color || "")) ? m.color : "#f59e0b",
    }))
    .sort((a, b) => a.time_sec - b.time_sec);
}

export function markerNearTime(body, timeSec, toleranceSec = 0.15) {
  const t = Math.max(0, Number(timeSec) || 0);
  let best = null;
  let bestDistance = Math.max(0, Number(toleranceSec) || 0);
  for (const marker of sortedMarkers(body)) {
    const d = Math.abs(marker.time_sec - t);
    if (d <= bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }
  return best;
}

export function previousMarker(body, currentSec, epsilon = 0.001) {
  const cur = Math.max(0, Number(currentSec) || 0);
  const markers = sortedMarkers(body);
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    if (markers[i].time_sec < cur - epsilon) return markers[i];
  }
  return null;
}

export function nextMarker(body, currentSec, epsilon = 0.001) {
  const cur = Math.max(0, Number(currentSec) || 0);
  for (const marker of sortedMarkers(body)) {
    if (marker.time_sec > cur + epsilon) return marker;
  }
  return null;
}

export function parseSubtitleTimecode(value) {
  const raw = String(value || "").trim().replace(",", ".");
  const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(String(match[4] || "0").padEnd(3, "0").slice(0, 3));
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function parseSubtitleText(rawText) {
  const text = String(rawText || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line || line.toUpperCase() === "WEBVTT" || line.startsWith("NOTE")) {
      i += 1;
      continue;
    }
    if (/^\d+$/.test(line) && lines[i + 1]?.includes("-->")) {
      i += 1;
      line = lines[i].trim();
    }
    if (!line.includes("-->")) {
      i += 1;
      continue;
    }
    const [startRaw, restRaw] = line.split("-->");
    const endRaw = String(restRaw || "").trim().split(/\s+/)[0];
    const start = parseSubtitleTimecode(startRaw);
    const end = parseSubtitleTimecode(endRaw);
    i += 1;
    const cueLines = [];
    while (i < lines.length && lines[i].trim()) {
      cueLines.push(lines[i].trim());
      i += 1;
    }
    if (start == null || end == null || end <= start || !cueLines.length) continue;
    const content = cueLines
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .trim();
    if (!content) continue;
    cues.push({ start, end, duration: Math.max(MIN_CLIP_VISIBLE_SEC, end - start), text: content });
  }
  return cues;
}

export function buildSubtitleOverlays(rawText, {
  presetId = "plain",
  fontFamily = "微软雅黑",
  fontFile = null,
  fontSize = 42,
  y = 0.82,
} = {}) {
  return parseSubtitleText(rawText).map((cue, index) => ({
    id: newOverlayId(),
    type: "text",
    timeline_start: cue.start,
    duration: cue.duration,
    fade_in_sec: 0,
    fade_out_sec: 0,
    transform: { x: 0.5, y, scale: 1, rotation: 0, width: 0.74, height: 0.16, opacity: 1 },
    text: {
      content: cue.text,
      font_family: fontFamily || "微软雅黑",
      font_file: fontFile || null,
      font_size: Math.max(12, Math.min(220, Number(fontSize) || 42)),
      preset_id: presetId || "plain",
      anim_in: null,
      anim_out: null,
    },
    meta: {
      name: cue.text,
      kind: "text",
      textStyleId: presetId || "plain",
      subtitle: true,
      subtitle_index: index + 1,
    },
  }));
}

export function snapTimelineSec(sec, body, { enabled = true, playheadSec = null } = {}) {
  const t = Math.max(0, Number(sec) || 0);
  if (!enabled) return t;
  const candidates = [0];
  if (playheadSec != null && Number.isFinite(Number(playheadSec))) {
    candidates.push(Number(playheadSec));
  }
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      const s = Number(clip.timeline_start) || 0;
      candidates.push(s, clipTimelineEnd(clip));
      for (const keyframe of clip.keyframes || []) {
        const local = Number(keyframe?.time_sec);
        if (Number.isFinite(local) && local >= 0) candidates.push(s + local);
      }
      for (const keyframe of clip.audio_keyframes || []) {
        const local = Number(keyframe?.time_sec);
        if (Number.isFinite(local) && local >= 0) candidates.push(s + local);
      }
    }
  }
  for (const ov of body?.overlays || []) {
    const s = Number(ov.timeline_start) || 0;
    candidates.push(s, s + (Number(ov.duration) || 0));
    for (const keyframe of ov.keyframes || []) {
      const local = Number(keyframe?.time_sec);
      if (Number.isFinite(local) && local >= 0) candidates.push(s + local);
    }
  }
  for (const marker of sortedMarkers(body)) {
    candidates.push(marker.time_sec);
  }
  let best = t;
  let bestD = 0.12;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export function overlaysActiveAt(body, timelineSec) {
  const t = Math.max(0, timelineSec);
  const hiddenTrackIds = new Set(
    (body?.overlay_tracks || []).filter((track) => track?.hidden).map((track) => String(track.id)),
  );
  return (body?.overlays || []).filter((ov) => {
    if (hiddenTrackIds.has(String(ov?.meta?.overlay_track_id || "ot1"))) return false;
    const start = Number(ov.timeline_start) || 0;
    const end = start + (Number(ov.duration) || 3);
    return t >= start && t <= end + 1e-4;
  });
}

export function timelineEditPoints(body) {
  const points = [0];
  for (const track of body?.tracks || []) {
    if (track.hidden) continue;
    for (const clip of track.clips || []) {
      const start = Math.max(0, Number(clip.timeline_start) || 0);
      points.push(start, clipTimelineEnd(clip));
      for (const keyframe of clip.keyframes || []) {
        const local = Number(keyframe?.time_sec);
        if (Number.isFinite(local) && local >= 0) points.push(start + local);
      }
      for (const keyframe of clip.audio_keyframes || []) {
        const local = Number(keyframe?.time_sec);
        if (Number.isFinite(local) && local >= 0) points.push(start + local);
      }
    }
  }
  for (const ov of body?.overlays || []) {
    const start = Math.max(0, Number(ov.timeline_start) || 0);
    points.push(start, overlayTimelineEnd(ov));
    for (const keyframe of ov.keyframes || []) {
      const local = Number(keyframe?.time_sec);
      if (Number.isFinite(local) && local >= 0) points.push(start + local);
    }
  }
  return [...new Set(points.map((p) => Math.max(0, Number(p) || 0).toFixed(3)))]
    .map(Number)
    .sort((a, b) => a - b);
}

export function projectFrameStepSec(body, fallbackFps = 30) {
  const fps = Number(body?.output?.fps);
  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.max(1, Math.min(240, fps)) : fallbackFps;
  return 1 / safeFps;
}

export function previousEditPoint(body, currentSec, epsilon = 0.001) {
  const cur = Math.max(0, Number(currentSec) || 0);
  const points = timelineEditPoints(body);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i] < cur - epsilon) return points[i];
  }
  return null;
}

export function nextEditPoint(body, currentSec, epsilon = 0.001) {
  const cur = Math.max(0, Number(currentSec) || 0);
  for (const point of timelineEditPoints(body)) {
    if (point > cur + epsilon) return point;
  }
  return null;
}

export function splitClipAt(clip, localSec) {
  const dur = clipMediaTimelineDuration(clip);
  const split = Math.max(0.05, Math.min(localSec, dur - 0.05));
  const trimIn = Number(clip.trim_in) || 0;
  const sourceSplit = clipSourceTimeForTimeline(clip, split);
  const left = {
    ...structuredClone(clip),
    trim_out: sourceSplit,
    transition_out: null,
    freeze_frame_sec: 0,
  };
  const right = {
    ...structuredClone(clip),
    id: newClipId(),
    timeline_start: (Number(clip.timeline_start) || 0) + split,
    trim_in: sourceSplit,
    trim_out: clip.trim_out,
    transition_out: clip.transition_out ? { ...clip.transition_out } : null,
  };
  return [rebaseTimelineClipKeyframes(clip, left), rebaseTimelineClipKeyframes(clip, right)];
}

export function canSplitTimelineClipAt(clip, playheadSec) {
  if (!clip) return false;
  const local = Math.max(0, Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0);
  const dur = clipMediaTimelineDuration(clip);
  return local > 0.05 && local < dur - 0.05;
}

export function trimClipEndDraft(clip, newEnd) {
  const start = Number(clip?.timeline_start) || 0;
  const maxEnd = clipMaxTimelineEnd(clip);
  const targetDuration = Math.max(MIN_CLIP_VISIBLE_SEC, Math.min(maxEnd, Number(newEnd) || start + MIN_CLIP_VISIBLE_SEC) - start);
  const sourceDuration = clipSourceMediaDuration(clip);
  const fullyExtended = { ...clip, trim_out: sourceDuration, freeze_frame_sec: 0 };
  const availableMediaDuration = clipMediaTimelineDuration(fullyExtended);
  if (targetDuration <= availableMediaDuration + 0.000001) {
    return {
      ...clip,
      trim_out: clipSourceTimeForTimeline(fullyExtended, targetDuration),
      freeze_frame_sec: 0,
    };
  }
  return {
    ...clip,
    trim_out: sourceDuration,
    freeze_frame_sec: Number(Math.min(clipFreezeFrameSec(clip), targetDuration - availableMediaDuration).toFixed(6)),
  };
}

export function trimClipStartDraft(clip, newStart) {
  const currentStart = Math.max(0, Number(clip?.timeline_start) || 0);
  const currentEnd = clipTimelineEnd(clip);
  const freeze = clipFreezeFrameSec(clip);
  const fullyExtended = { ...clip, trim_in: 0, freeze_frame_sec: 0 };
  const fullMediaDuration = clipMediaTimelineDuration(fullyExtended);
  const earliestStart = Math.max(0, currentEnd - freeze - fullMediaDuration);
  const targetStart = Math.max(earliestStart, Math.min(currentEnd - MIN_CLIP_VISIBLE_SEC, Number(newStart) || 0));
  const targetMediaDuration = Math.max(MIN_CLIP_VISIBLE_SEC, currentEnd - targetStart - freeze);
  const trimmedPrefixDuration = Math.max(0, fullMediaDuration - targetMediaDuration);
  return {
    ...clip,
    timeline_start: targetStart,
    trim_in: clipSourceTimeForTimeline(fullyExtended, trimmedPrefixDuration),
  };
}

export function canSplitTimelineOverlayAt(overlay, playheadSec) {
  if (!overlay) return false;
  const local = Math.max(0, Number(playheadSec) || 0) - (Number(overlay.timeline_start) || 0);
  const dur = Math.max(0, Number(overlay.duration) || 0);
  return local > 0.05 && local < dur - 0.05;
}

export function canSplitTrackClipsAtPlayhead(track, playheadSec) {
  if (!track || track.locked || track.hidden) return false;
  return (track.clips || []).some((clip) => canSplitTimelineClipAt(clip, playheadSec));
}

export function splitTrackClipsAtPlayhead(track, playheadSec) {
  if (!track || track.locked || track.hidden) return { changed: false, clips: track?.clips || [], newIds: [], splitPairs: [] };
  const t = Math.max(0, Number(playheadSec) || 0);
  let changed = false;
  const newIds = [];
  const splitPairs = [];
  const clips = [];
  for (const clip of sortClips(track.clips || [])) {
    if (!canSplitTimelineClipAt(clip, t)) {
      clips.push(clip);
      continue;
    }
    const local = t - (Number(clip.timeline_start) || 0);
    const [left, right] = splitClipAt(clip, local);
    clips.push(left, right);
    newIds.push(right.id);
    splitPairs.push({ id: String(clip.id), rightId: String(right.id) });
    changed = true;
  }
  return { changed, clips: sortClips(clips), newIds, splitPairs };
}

export function canSplitOverlaysAtPlayhead(overlays, playheadSec) {
  return (overlays || []).some((overlay) => canSplitTimelineOverlayAt(overlay, playheadSec));
}

export function splitOverlaysAtPlayhead(overlays, playheadSec) {
  const t = Math.max(0, Number(playheadSec) || 0);
  let changed = false;
  const newIds = [];
  const next = [];
  for (const overlay of overlays || []) {
    if (!canSplitTimelineOverlayAt(overlay, t)) {
      next.push(overlay);
      continue;
    }
    const local = t - (Number(overlay.timeline_start) || 0);
    const [left, right] = splitOverlayAt(overlay, local);
    next.push(left, right);
    newIds.push(right.id);
    changed = true;
  }
  return {
    changed,
    overlays: next.sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0)),
    newIds,
  };
}

export function cloneTimelineClipForPaste(clip, timelineStart) {
  if (!clip) return null;
  return {
    ...structuredClone(clip),
    id: newClipId(),
    timeline_start: Math.max(0, Number(timelineStart) || 0),
  };
}

export function cloneOverlayForPaste(overlay, timelineStart) {
  if (!overlay) return null;
  return {
    ...structuredClone(overlay),
    id: newOverlayId(),
    timeline_start: Math.max(0, Number(timelineStart) || 0),
  };
}

export function insertClipIntoTrackWithRipple(track, clip) {
  if (!track || !clip) return { inserted: false, clips: track?.clips || [] };
  const start = Math.max(0, Number(clip.timeline_start) || 0);
  const duration = clipSourceDuration(clip);
  for (const existing of track.clips || []) {
    const existingStart = Number(existing.timeline_start) || 0;
    const existingEnd = clipTimelineEnd(existing);
    if (existingStart < start - 1e-6 && existingEnd > start + 1e-6) {
      return { inserted: false, clips: track.clips || [] };
    }
  }
  const shifted = (track.clips || []).map((existing) => {
    const existingStart = Number(existing.timeline_start) || 0;
    if (existingStart >= start - 1e-6) {
      return { ...existing, timeline_start: existingStart + duration };
    }
    return existing;
  });
  return { inserted: true, clips: sortClips([...shifted, { ...clip, timeline_start: start }]) };
}

export function insertOverlayWithRipple(overlays, overlay) {
  if (!overlay) return { inserted: false, overlays: overlays || [] };
  const start = Math.max(0, Number(overlay.timeline_start) || 0);
  const duration = Math.max(MIN_CLIP_VISIBLE_SEC, Number(overlay.duration) || 0);
  const shifted = (overlays || []).map((existing) => {
    const existingStart = Number(existing.timeline_start) || 0;
    if (existingStart >= start - 1e-6) {
      return { ...existing, timeline_start: existingStart + duration };
    }
    return existing;
  });
  return {
    inserted: true,
    overlays: [...shifted, { ...overlay, timeline_start: start }].sort(
      (a, b) => (a.timeline_start || 0) - (b.timeline_start || 0),
    ),
  };
}

export function nudgeClipInTrack(track, clipId, deltaSec) {
  if (!track || track.locked) return { moved: false, clips: track?.clips || [], start: null };
  const clip = (track.clips || []).find((c) => c.id === clipId);
  if (!clip) return { moved: false, clips: track.clips || [], start: null };
  const current = Number(clip.timeline_start) || 0;
  const nextStart = Math.max(0, current + (Number(deltaSec) || 0));
  if (Math.abs(nextStart - current) <= 1e-6) return { moved: false, clips: track.clips || [], start: current };
  const duration = clipSourceDuration(clip);
  if (!canPlaceOnTrack(track.clips || [], nextStart, duration, clipId)) {
    return { moved: false, clips: track.clips || [], start: current };
  }
  const clips = sortClips((track.clips || []).map((c) => (c.id === clipId ? { ...c, timeline_start: nextStart } : c)));
  return { moved: true, clips, start: nextStart };
}

/** 在不改变时间线位置或长度的前提下，移动素材内部取段。 */
export function slipClipInTrack(track, clipId, deltaSec) {
  if (!track || track.locked) return { moved: false, clips: track?.clips || [], trimIn: null };
  const clip = (track.clips || []).find((candidate) => candidate.id === clipId);
  if (!clip) return { moved: false, clips: track.clips || [], trimIn: null };
  if (normalizedClipSpeedKeyframes(clip).length) return { moved: false, clips: track.clips || [], trimIn: Number(clip.trim_in) || 0 };
  const rawDelta = Number(deltaSec) || 0;
  if (Math.abs(rawDelta) <= 1e-6) return { moved: false, clips: track.clips || [], trimIn: Number(clip.trim_in) || 0 };

  const sourceDuration = Number(clip.meta?.duration_sec);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= MIN_CLIP_VISIBLE_SEC) {
    return { moved: false, clips: track.clips || [], trimIn: Number(clip.trim_in) || 0 };
  }
  const trimIn = Math.max(0, Number(clip.trim_in) || 0);
  const trimOut = Number(clip.trim_out);
  const currentTrimOut = Number.isFinite(trimOut) ? Math.min(sourceDuration, Math.max(trimIn + MIN_CLIP_VISIBLE_SEC, trimOut)) : sourceDuration;
  const visibleSourceDuration = Math.max(MIN_CLIP_VISIBLE_SEC, currentTrimOut - trimIn);
  const maxTrimIn = Math.max(0, sourceDuration - visibleSourceDuration);
  const nextTrimIn = Math.max(0, Math.min(maxTrimIn, trimIn + rawDelta * clipPlaybackSpeed(clip)));
  if (Math.abs(nextTrimIn - trimIn) <= 1e-6) return { moved: false, clips: track.clips || [], trimIn };

  const nextTrimOut = nextTrimIn + visibleSourceDuration;
  const clips = (track.clips || []).map((candidate) =>
    candidate.id === clipId ? { ...candidate, trim_in: nextTrimIn, trim_out: nextTrimOut } : candidate,
  );
  return { moved: true, clips, trimIn: nextTrimIn };
}

export function nudgeOverlayInList(overlays, overlayId, deltaSec) {
  const ov = (overlays || []).find((o) => o.id === overlayId);
  if (!ov) return { moved: false, overlays: overlays || [], start: null };
  const current = Number(ov.timeline_start) || 0;
  const nextStart = Math.max(0, current + (Number(deltaSec) || 0));
  if (Math.abs(nextStart - current) <= 1e-6) return { moved: false, overlays: overlays || [], start: current };
  const next = (overlays || [])
    .map((o) => (o.id === overlayId ? { ...o, timeline_start: nextStart } : o))
    .sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0));
  return { moved: true, overlays: next, start: nextStart };
}

export function rippleDeleteClipFromTrack(track, clipId) {
  const clip = (track?.clips || []).find((c) => c.id === clipId);
  if (!clip) return { deleted: false, clips: track?.clips || [], duration: 0 };
  const start = Number(clip.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  const duration = clipSourceDuration(clip);
  const clips = sortClips(
    (track.clips || [])
      .filter((c) => c.id !== clipId)
      .map((c) => {
        const cStart = Number(c.timeline_start) || 0;
        if (cStart >= end - 1e-6) {
          return { ...c, timeline_start: Math.max(start, cStart - duration) };
        }
        return c;
      }),
  );
  return { deleted: true, clips, duration };
}

export function rippleDeleteOverlayFromList(overlays, overlayId) {
  const ov = (overlays || []).find((o) => o.id === overlayId);
  if (!ov) return { deleted: false, overlays: overlays || [], duration: 0 };
  const start = Number(ov.timeline_start) || 0;
  const end = overlayTimelineEnd(ov);
  const duration = Math.max(MIN_CLIP_VISIBLE_SEC, Number(ov.duration) || 0);
  const next = (overlays || [])
    .filter((o) => o.id !== overlayId)
    .map((o) => {
      const oStart = Number(o.timeline_start) || 0;
      if (oStart >= end - 1e-6) {
        return { ...o, timeline_start: Math.max(start, oStart - duration) };
      }
      return o;
    })
    .sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0));
  return { deleted: true, overlays: next, duration };
}
