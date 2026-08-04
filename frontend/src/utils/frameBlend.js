const FRAME_RATE_TOLERANCE = 0.5;
const MIN_FRAME_BLEND_SOURCE_FPS = 120;

function nearFrameRate(actual, expected) {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= FRAME_RATE_TOLERANCE;
}

export function isFrameBlendSourceSupported(sourceFps) {
  const value = Number(sourceFps);
  return Number.isFinite(value) && value >= MIN_FRAME_BLEND_SOURCE_FPS - FRAME_RATE_TOLERANCE;
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
 * Return the deterministic high-frame delivery plan supported by the backend.
 * A null result means the legacy/manual frame-blend setting should remain in use.
 */
export function getHighFrameBlendPlan(sourceFps, deliveryFps) {
  if (!nearFrameRate(deliveryFps, 60)) return null;
  if (nearFrameRate(sourceFps, 240)) return { sourceFps: 240, deliveryFps: 60, frames: 4 };
  if (nearFrameRate(sourceFps, 120)) return { sourceFps: 120, deliveryFps: 60, frames: 2 };
  return null;
}

export function effectiveHighFrameBlendFrames(sourceFps, deliveryFps, fallback = 5) {
  return getHighFrameBlendPlan(sourceFps, deliveryFps)?.frames ?? fallback;
}
