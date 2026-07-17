const TRANSFORM_DEFAULTS = { x: 0.5, y: 0.5, scale: 1, rotation: 0, width: 0.33, height: 0.33, opacity: 1 };
export const VIDEO_LAYER_TRANSFORM_DEFAULTS = { x: 0.5, y: 0.5, scale: 1, rotation: 0, width: 1, height: 1, opacity: 1 };
const INTERPOLATED_FIELDS = ["x", "y", "scale", "rotation", "width", "height", "opacity"];

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizedOverlayTransform(transform, defaults = TRANSFORM_DEFAULTS) {
  const raw = transform || {};
  return {
    x: Math.max(0, Math.min(1, number(raw.x, defaults.x))),
    y: Math.max(0, Math.min(1, number(raw.y, defaults.y))),
    scale: Math.max(0.01, Math.min(4, number(raw.scale, defaults.scale))),
    rotation: Math.max(-360, Math.min(360, number(raw.rotation, defaults.rotation))),
    width: Math.max(0.01, Math.min(10, number(raw.width, defaults.width))),
    height: Math.max(0.01, Math.min(10, number(raw.height, defaults.height))),
    opacity: Math.max(0, Math.min(1, number(raw.opacity, defaults.opacity))),
  };
}

export function normalizedOverlayKeyframes(overlay, defaults = TRANSFORM_DEFAULTS) {
  const duration = Math.max(0, number(overlay?.duration, 0));
  return (overlay?.keyframes || [])
    .map((keyframe) => ({
      time_sec: Math.max(0, Math.min(duration, number(keyframe?.time_sec, 0))),
      transform: normalizedOverlayTransform(keyframe?.transform, defaults),
    }))
    .sort((a, b) => a.time_sec - b.time_sec);
}

export function overlayTransformAt(overlay, playheadSec, defaults = TRANSFORM_DEFAULTS) {
  const base = normalizedOverlayTransform(overlay?.transform, defaults);
  const local = Math.max(0, Math.min(number(overlay?.duration, 0), number(playheadSec, 0) - number(overlay?.timeline_start, 0)));
  const keyframes = normalizedOverlayKeyframes(overlay, defaults);
  if (!keyframes.length || local <= keyframes[0].time_sec) return keyframes[0]?.transform || base;
  const last = keyframes.at(-1);
  if (local >= last.time_sec) return last.transform;
  const nextIndex = keyframes.findIndex((keyframe) => keyframe.time_sec >= local);
  const after = keyframes[nextIndex];
  const before = keyframes[nextIndex - 1];
  const amount = (local - before.time_sec) / Math.max(0.0001, after.time_sec - before.time_sec);
  const out = {};
  for (const field of INTERPOLATED_FIELDS) out[field] = before.transform[field] + (after.transform[field] - before.transform[field]) * amount;
  return normalizedOverlayTransform(out, defaults);
}

export function keyframeNearPlayhead(overlay, playheadSec, toleranceSec = 0.04, defaults = TRANSFORM_DEFAULTS) {
  const local = number(playheadSec, 0) - number(overlay?.timeline_start, 0);
  return normalizedOverlayKeyframes(overlay, defaults).find((keyframe) => Math.abs(keyframe.time_sec - local) <= toleranceSec) || null;
}
