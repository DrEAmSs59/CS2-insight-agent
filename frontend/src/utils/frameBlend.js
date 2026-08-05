const FRAME_RATE_TOLERANCE = 0.5;
const MIN_FRAME_BLEND_SOURCE_FPS = 1;

function nearFrameRate(actual, expected) {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= FRAME_RATE_TOLERANCE;
}

export function isFrameBlendSourceSupported(sourceFps) {
  const value = Number(sourceFps);
  return Number.isFinite(value) && value >= MIN_FRAME_BLEND_SOURCE_FPS;
}

export function getClipFps(clip) {
  const value = Number(clip?.fps ?? clip?.frame_rate);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function summarizeFrameBlendSources(clips = []) {
  const fpsValues = clips.map(getClipFps);
  const lowFpsValues = fpsValues.filter((value) => value != null && !isFrameBlendSourceSupported(value));
  return {
    fpsValues,
    primaryFps: fpsValues[0] ?? null,
    hasUnknownFps: fpsValues.some((value) => value == null),
    lowFpsValues,
    allSupported: fpsValues.length > 0 && fpsValues.every((value) => value != null && isFrameBlendSourceSupported(value)),
  };
}

/**
 * Preview the source-aware integer-multiple policy implemented by the custom
 * FFmpeg runtime. The runtime remains authoritative and preserves rational FPS.
 */
export function getHighFrameBlendPlan(sourceFps, deliveryFps) {
  if (!nearFrameRate(deliveryFps, 60)) return null;
  const source = Number(sourceFps);
  if (!Number.isFinite(source) || source < MIN_FRAME_BLEND_SOURCE_FPS) return null;
  const minimumTarget = source < 56 ? 200 : 300;
  const multiplier = source >= 300 ? 1 : Math.max(1, Math.ceil(minimumTarget / source));
  const targetFps = source * multiplier;
  return {
    sourceFps: source,
    targetFps,
    deliveryFps: 60,
    multiplier,
    frames: Math.max(2, Math.min(9, Math.round(targetFps / 60))),
  };
}

export function effectiveHighFrameBlendFrames(sourceFps, deliveryFps, fallback = 5) {
  return getHighFrameBlendPlan(sourceFps, deliveryFps)?.frames ?? fallback;
}
