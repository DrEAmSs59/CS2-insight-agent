/** Pure camera math for whole-scene 2D replay zoom/pan. */

export const USER_ZOOM_MIN = 0.6;
export const USER_ZOOM_MAX = 3;
export const USER_ZOOM_STEP = 1.15;
export const DEFAULT_COVER_RATIO = 0.88;
export const SCENE_SIZE = 1024;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Scale so contentRect fills ~coverRatio of the viewport (contain).
 * @param {{ width: number, height: number }} viewport
 * @param {{ width: number, height: number }} contentRect
 * @param {{ coverRatio?: number }} [options]
 */
export function computeFitScale(viewport, contentRect, { coverRatio = DEFAULT_COVER_RATIO } = {}) {
  const vw = Number(viewport?.width);
  const vh = Number(viewport?.height);
  const cw = Number(contentRect?.width);
  const ch = Number(contentRect?.height);
  if (!(vw > 0) || !(vh > 0) || !(cw > 0) || !(ch > 0)) return 1;
  const ratio = Number(coverRatio);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_COVER_RATIO;
  return Math.min(vw / cw, vh / ch) * safeRatio;
}

/** Clamp userZoom to [0.6, 3]. */
export function clampUserZoom(z) {
  const value = Number(z);
  if (!Number.isFinite(value)) return 1;
  return clamp(value, USER_ZOOM_MIN, USER_ZOOM_MAX);
}

/**
 * Zoom around a viewport pointer so the same scene point stays under the cursor.
 * @returns {{ offsetX: number, offsetY: number, scale: number }}
 */
export function zoomAtPointer({ offsetX, offsetY, scale, pointerX, pointerY, nextScale }) {
  const currentScale = Number(scale);
  const targetScale = Number(nextScale);
  const ox = Number(offsetX) || 0;
  const oy = Number(offsetY) || 0;
  const px = Number(pointerX) || 0;
  const py = Number(pointerY) || 0;
  if (!(currentScale > 0) || !(targetScale > 0)) {
    return { offsetX: ox, offsetY: oy, scale: currentScale > 0 ? currentScale : 1 };
  }
  const sceneX = (px - ox) / currentScale;
  const sceneY = (py - oy) / currentScale;
  return {
    offsetX: px - sceneX * targetScale,
    offsetY: py - sceneY * targetScale,
    scale: targetScale,
  };
}

function cameraFinalScale(camera) {
  const fit = Number(camera?.fitScale);
  const zoom = Number(camera?.userZoom);
  const fitScale = Number.isFinite(fit) && fit > 0 ? fit : 1;
  const userZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return fitScale * userZoom;
}

/**
 * Pan by viewport pixels; clamp so the scene cannot leave the viewport entirely.
 * @returns {typeof camera}
 */
export function panBy(camera, dx, dy, viewport, sceneSize) {
  const scale = cameraFinalScale(camera);
  const sw = (Number(sceneSize?.width) || SCENE_SIZE) * scale;
  const sh = (Number(sceneSize?.height) || SCENE_SIZE) * scale;
  const vw = Number(viewport?.width) || 0;
  const vh = Number(viewport?.height) || 0;
  const minOverlapX = Math.min(48, Math.max(1, vw * 0.1));
  const minOverlapY = Math.min(48, Math.max(1, vh * 0.1));
  const nextX = (Number(camera?.offsetX) || 0) + (Number(dx) || 0);
  const nextY = (Number(camera?.offsetY) || 0) + (Number(dy) || 0);
  return {
    ...camera,
    offsetX: clamp(nextX, minOverlapX - sw, vw - minOverlapX),
    offsetY: clamp(nextY, minOverlapY - sh, vh - minOverlapY),
  };
}

/** CSS transform with origin 0 0: `translate(ox,oy) scale(s)`. */
export function cameraCssTransform(camera) {
  const ox = Number(camera?.offsetX) || 0;
  const oy = Number(camera?.offsetY) || 0;
  const scale = Number(camera?.scale);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return `translate(${ox}px, ${oy}px) scale(${s})`;
}

/**
 * Center contentRect within the viewport at the given fitScale.
 * @returns {{ offsetX: number, offsetY: number }}
 */
export function computeFitOffset(viewport, contentRect, fitScale) {
  const scale = Number(fitScale) > 0 ? Number(fitScale) : 1;
  const cx = Number(contentRect?.x ?? contentRect?.content_x) || 0;
  const cy = Number(contentRect?.y ?? contentRect?.content_y) || 0;
  const cw = Number(contentRect?.width) || SCENE_SIZE;
  const ch = Number(contentRect?.height) || SCENE_SIZE;
  const vw = Number(viewport?.width) || 0;
  const vh = Number(viewport?.height) || 0;
  return {
    offsetX: (vw - cw * scale) / 2 - cx * scale,
    offsetY: (vh - ch * scale) / 2 - cy * scale,
  };
}

/**
 * Build a fitted camera for the current map/viewport.
 * @returns {{ fitScale: number, userZoom: number, offsetX: number, offsetY: number }}
 */
export function createFittedCamera(viewport, contentRect, { coverRatio = DEFAULT_COVER_RATIO } = {}) {
  const fitScale = computeFitScale(viewport, contentRect, { coverRatio });
  const { offsetX, offsetY } = computeFitOffset(viewport, contentRect, fitScale);
  return {
    fitScale,
    userZoom: 1,
    offsetX,
    offsetY,
  };
}

export function contentRectFromTransform(transform) {
  return {
    x: Number(transform?.content_x) || 0,
    y: Number(transform?.content_y) || 0,
    width: Number(transform?.content_width) || SCENE_SIZE,
    height: Number(transform?.content_height) || SCENE_SIZE,
  };
}

/**
 * Same-map viewport/contentRect resize while zoomed: scale offsets by fitScale
 * ratio, then clamp so the scene cannot leave the viewport with no overlap.
 */
export function rescaleCameraForFitChange(camera, nextFitScale, viewport, sceneSize = { width: SCENE_SIZE, height: SCENE_SIZE }) {
  const fittedFit = Number(nextFitScale) > 0 ? Number(nextFitScale) : 1;
  const prevFit = Number(camera?.fitScale) > 0 ? Number(camera.fitScale) : fittedFit;
  const ratio = fittedFit / prevFit;
  const scaled = {
    ...camera,
    fitScale: fittedFit,
    offsetX: (Number(camera?.offsetX) || 0) * ratio,
    offsetY: (Number(camera?.offsetY) || 0) * ratio,
  };
  return panBy(scaled, 0, 0, viewport, sceneSize);
}

/**
 * Restore a saved per-map camera into the current viewport fitScale.
 * Scales pan offsets by fitted.fitScale / saved.fitScale, then clamps.
 */
export function restoreCameraForViewport(saved, fitted, viewport) {
  const savedFit = Number(saved?.fitScale);
  const fittedFit = Number(fitted?.fitScale) > 0 ? Number(fitted.fitScale) : 1;
  if (!(savedFit > 0)) {
    return fitted || createFittedCamera(viewport, { x: 0, y: 0, width: SCENE_SIZE, height: SCENE_SIZE });
  }
  const ratio = fittedFit / savedFit;
  const restored = {
    fitScale: fittedFit,
    userZoom: clampUserZoom(saved?.userZoom),
    offsetX: Number.isFinite(Number(saved?.offsetX)) ? Number(saved.offsetX) * ratio : (Number(fitted?.offsetX) || 0),
    offsetY: Number.isFinite(Number(saved?.offsetY)) ? Number(saved.offsetY) * ratio : (Number(fitted?.offsetY) || 0),
  };
  return panBy(restored, 0, 0, viewport, { width: SCENE_SIZE, height: SCENE_SIZE });
}
