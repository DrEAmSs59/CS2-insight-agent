/** Shared world ↔ radar transforms for 2D replay overlays. */

export const RADAR_MAP_SIZE = 1024;

/**
 * Prefer live API transform over stale workspace metadata.
 * @param {{ responseTransform?: object|null, workspaceTransform?: object|null, fallbackTransform?: object|null }} sources
 */
export function resolveReplayTransform({
  responseTransform = null,
  workspaceTransform = null,
  fallbackTransform = null,
} = {}) {
  return responseTransform || workspaceTransform || fallbackTransform || null;
}

export function worldToRadarPixel(point, transform, viewport = { width: RADAR_MAP_SIZE, height: RADAR_MAP_SIZE }) {
  const percent = worldToRadarPercent(point, transform);
  if (!percent) return null;
  const width = Number(viewport?.width) || RADAR_MAP_SIZE;
  const height = Number(viewport?.height) || RADAR_MAP_SIZE;
  return {
    x: (percent.x / 100) * width,
    y: (percent.y / 100) * height,
  };
}

export function worldToRadarPercent(point, transform) {
  if (!transform || !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return null;
  const scale = Number(transform.scale);
  if (!Number.isFinite(scale) || scale === 0) return null;
  // Match awpy game_to_pixel / current production formula. Metadata `rotate`
  // is recorded for overview assets but modern bundled PNGs already align with
  // this mapping; do not swap axes without per-map image verification.
  // Overlay percents are relative to the full 1024 PNG scene. `content_*` is
  // Fit-camera only (inset of playable radar within that PNG) — do not use it here.
  const mapX = (Number(point.x) - Number(transform.pos_x)) / scale;
  const mapY = (Number(transform.pos_y) - Number(point.y)) / scale;
  if (!Number.isFinite(mapX) || !Number.isFinite(mapY)) return null;
  return {
    x: (mapX / RADAR_MAP_SIZE) * 100,
    y: (mapY / RADAR_MAP_SIZE) * 100,
  };
}

export function worldLengthToRadarPixel(length, transform, viewport = { width: RADAR_MAP_SIZE, height: RADAR_MAP_SIZE }) {
  const scale = Number(transform?.scale);
  if (!Number.isFinite(scale) || scale === 0) return 0;
  const size = Math.min(Number(viewport?.width) || RADAR_MAP_SIZE, Number(viewport?.height) || RADAR_MAP_SIZE);
  return (Number(length) || 0) / scale / RADAR_MAP_SIZE * size;
}

export function worldLengthToRadarPercent(length, transform) {
  const scale = Number(transform?.scale);
  if (!Number.isFinite(scale) || scale === 0) return 0;
  return ((Number(length) || 0) / scale / RADAR_MAP_SIZE) * 100;
}

export function radarPixelToWorld(point, transform, viewport = { width: RADAR_MAP_SIZE, height: RADAR_MAP_SIZE }) {
  if (!transform || !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return null;
  const scale = Number(transform.scale);
  if (!Number.isFinite(scale) || scale === 0) return null;
  const width = Number(viewport?.width) || RADAR_MAP_SIZE;
  const height = Number(viewport?.height) || RADAR_MAP_SIZE;
  const mapX = (Number(point.x) / width) * RADAR_MAP_SIZE;
  const mapY = (Number(point.y) / height) * RADAR_MAP_SIZE;
  return {
    x: Number(transform.pos_x) + mapX * scale,
    y: Number(transform.pos_y) - mapY * scale,
  };
}

/**
 * CSS degrees for an arrow that points "up" at rotate(0).
 * CS yaw 0 = +X (east), 90 = +Y (north). Radar Y is flipped, so north is screen-up.
 */
export function yawToCssRotation(yawDegrees) {
  return 90 - (Number(yawDegrees) || 0);
}
