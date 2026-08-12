import {
  normalizeSceneTransform,
  SCENE_TRANSFORM_DEFAULTS,
} from "../state/sceneTransform.js";

const CANVAS_SNAP_POINTS = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
const ROTATION_SNAP_POINTS = Object.freeze([-180, -120, -90, -60, -30, 0, 30, 60, 90, 120, 180]);

export function snapCanvasValue(value, tolerance = 0.012) {
  const numeric = Number(value) || 0;
  const nearest = CANVAS_SNAP_POINTS.reduce(
    (best, point) => (Math.abs(point - numeric) < Math.abs(best - numeric) ? point : best),
    CANVAS_SNAP_POINTS[0],
  );
  return Math.abs(nearest - numeric) <= tolerance
    ? { value: nearest, guide: nearest }
    : { value: numeric, guide: null };
}

export function scenePositionForCanvasDrag({
  x,
  y,
  deltaX,
  deltaY,
  canvasWidth,
  canvasHeight,
}) {
  const normalized = normalizeSceneTransform({
    ...SCENE_TRANSFORM_DEFAULTS,
    x: (Number(x) || 0) + (Number(deltaX) || 0) / Math.max(1, Number(canvasWidth) || 1),
    y: (Number(y) || 0) + (Number(deltaY) || 0) / Math.max(1, Number(canvasHeight) || 1),
  });
  const horizontal = snapCanvasValue(normalized.x);
  const vertical = snapCanvasValue(normalized.y);
  return {
    x: horizontal.value,
    y: vertical.value,
    guides: { x: horizontal.guide, y: vertical.guide },
  };
}

export function clampSceneScale(value) {
  return normalizeSceneTransform({ ...SCENE_TRANSFORM_DEFAULTS, scale: value }).scale;
}

export function clampSceneSize(value) {
  return normalizeSceneTransform({ ...SCENE_TRANSFORM_DEFAULTS, width: value }).width;
}

export function snapCanvasRotation(value) {
  const normalized = Math.max(-180, Math.min(180, Number(value) || 0));
  const nearest = ROTATION_SNAP_POINTS.reduce(
    (best, point) => (Math.abs(point - normalized) < Math.abs(best - normalized) ? point : best),
    ROTATION_SNAP_POINTS[0],
  );
  return Math.abs(nearest - normalized) <= 3 ? nearest : normalized;
}
