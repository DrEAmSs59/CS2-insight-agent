import {
  VISUAL_FREEZE_DEFAULT_SEC,
  VISUAL_FREEZE_MAX_SEC,
  VISUAL_FREEZE_MIN_SEC,
  VISUAL_SPEED_DEFAULT,
  VISUAL_SPEED_MAX,
  VISUAL_SPEED_MIN,
  visualContentFit,
} from "./visualMaterial.js";

export const MIN_CLIP_VISIBLE_SEC = 0.1;

export function clipPlaybackSpeed(clip) {
  const speed = Number(clip?.speed);
  return Number.isFinite(speed) && speed > 0 ? Math.max(VISUAL_SPEED_MIN, Math.min(VISUAL_SPEED_MAX, speed)) : VISUAL_SPEED_DEFAULT;
}

export function clipTrimmedSourceDuration(clip) {
  if (!clip) return 5;
  const trimOut = clip.trim_out;
  const trimIn = Number(clip.trim_in) || 0;
  if (trimOut != null && Number.isFinite(Number(trimOut))) {
    return Math.max(MIN_CLIP_VISIBLE_SEC, Number(trimOut) - trimIn);
  }
  const meta = clip.meta;
  if (meta && Number.isFinite(Number(meta.duration_sec))) {
    return Math.max(MIN_CLIP_VISIBLE_SEC, Number(meta.duration_sec) - trimIn);
  }
  return 5;
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
      speed: Math.max(VISUAL_SPEED_MIN, Math.min(VISUAL_SPEED_MAX, speed)),
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

export function clipMediaTimelineDuration(clip) {
  return Math.max(MIN_CLIP_VISIBLE_SEC, clipTimelineTimeForSource(clip, (Number(clip?.trim_in) || 0) + clipTrimmedSourceDuration(clip)));
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
  return Number.isFinite(freeze) ? Math.max(VISUAL_FREEZE_MIN_SEC, Math.min(VISUAL_FREEZE_MAX_SEC, freeze)) : VISUAL_FREEZE_DEFAULT_SEC;
}

export function clipReversePlayback(clip) {
  return Boolean(clip?.reverse);
}

export function clipPreservePitch(clip) {
  return clip?.preserve_pitch !== false;
}

export function clipCanvasFit(clip, fallback = "contain") {
  return visualContentFit(clip, fallback);
}

export function clipTimelineDuration(clip) {
  return clipMediaTimelineDuration(clip) + clipFreezeFrameSec(clip);
}

export function clipSourceDuration(clip) {
  return clipTimelineDuration(clip);
}

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

export function clipSourceMediaDuration(clip) {
  if (!clip) return 5;
  const meta = clip.meta;
  if (meta && Number.isFinite(Number(meta.duration_sec)) && Number(meta.duration_sec) > 0) {
    return Number(meta.duration_sec);
  }
  return ensureClipSourceDuration(clip);
}

export function clipMaxTimelineEnd(clip) {
  const start = Number(clip.timeline_start) || 0;
  const sourceDur = clipSourceMediaDuration(clip);
  const extended = { ...clip, trim_out: sourceDur };
  return start + Math.max(MIN_CLIP_VISIBLE_SEC, clipTimelineTimeForSource(extended, sourceDur)) + clipFreezeFrameSec(clip);
}

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
