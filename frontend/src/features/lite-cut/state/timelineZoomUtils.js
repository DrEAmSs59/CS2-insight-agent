export const TIMELINE_ZOOM_MIN = 0.04;
export const TIMELINE_ZOOM_MAX = 8;
export const TIMELINE_ZOOM_DEFAULT = 1;
export const TIMELINE_PIXELS_PER_SECOND = 44;

export function clampTimelineZoom(value, fallback = TIMELINE_ZOOM_DEFAULT) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, safe));
}

export function timelineZoomToSliderPercent(value) {
  const zoom = clampTimelineZoom(value);
  const scale = Math.log(TIMELINE_ZOOM_MAX / TIMELINE_ZOOM_MIN);
  return (Math.log(zoom / TIMELINE_ZOOM_MIN) / scale) * 100;
}

export function timelineZoomFromSliderPercent(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return clampTimelineZoom(TIMELINE_ZOOM_MIN * Math.pow(TIMELINE_ZOOM_MAX / TIMELINE_ZOOM_MIN, percent / 100));
}

export function timelinePixelsPerSecond(value) {
  return TIMELINE_PIXELS_PER_SECOND * clampTimelineZoom(value);
}
