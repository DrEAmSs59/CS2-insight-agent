const SOURCE_FPS_TOLERANCE = 0.5;
const MIN_SOURCE_FPS = 1;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"]);

export function isFrameMeldImagePath(path) {
  const normalized = String(path || "").trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 && IMAGE_EXTENSIONS.has(normalized.slice(dotIndex));
}

export function getFrameMeldSourceFps(clip) {
  const value = Number(clip?.fps ?? clip?.frame_rate);
  return Number.isFinite(value) && value >= MIN_SOURCE_FPS ? value : null;
}

export function summarizeFrameMeldSources(clips = []) {
  const fpsValues = clips.map(getFrameMeldSourceFps);
  const validValues = fpsValues.filter((value) => value != null);
  const hasUnknownFps = validValues.length !== fpsValues.length;
  const hasMixedFrameRates = validValues.length > 1
    && Math.max(...validValues) - Math.min(...validValues) > SOURCE_FPS_TOLERANCE;
  return {
    fpsValues,
    primaryFps: validValues[0] ?? null,
    hasUnknownFps,
    hasMixedFrameRates,
    compatible: fpsValues.length > 0 && !hasUnknownFps && !hasMixedFrameRates,
  };
}
