import { useEffect, useMemo, useRef } from "react";
import {
  buildDensityMask,
  marchingSquares,
  sampleCrossfadeAlpha,
  smoothMask,
  supersampleMask,
} from "./smokeContour";

const MAP_SIZE = 1024;
const INFERNO_CELL_RADIUS_WORLD = 36;
const DEFAULT_SMOKE_CELL_SIZE = 20;
const SMOKE_CONTOUR_THRESHOLD = 0.15;

function worldToPercent(point, transform) {
  if (!transform || !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return null;
  const scale = Number(transform.scale) || 1;
  const px = (Number(point.x) - Number(transform.pos_x)) / scale;
  const py = (Number(transform.pos_y) - Number(point.y)) / scale;
  return { x: (px / MAP_SIZE) * 100, y: (py / MAP_SIZE) * 100 };
}

function worldRadiusToPercent(radiusWorld, transform) {
  const scale = Number(transform?.scale) || 1;
  return ((Number(radiusWorld) || 0) / scale / MAP_SIZE) * 100;
}

function mapLayerThreshold(transform) {
  const value = Number(transform?.lower_level_max_units);
  return Number.isFinite(value) ? value : null;
}

function pointMatchesMapLayer(point, transform, mapLayer) {
  const threshold = mapLayerThreshold(transform);
  if (threshold == null || !mapLayer) return true;
  const z = Number(point?.z);
  if (!Number.isFinite(z)) return true;
  return mapLayer === "lower" ? z <= threshold : z > threshold;
}

export function selectActiveSample(track, currentTick, hideAfterTick = null) {
  if (!track || !Array.isArray(track.samples) || !track.samples.length) return null;
  const tick = Number(currentTick);
  if (!Number.isFinite(tick)) return null;
  if (tick < Number(track.start_tick)) return null;
  if (Number.isFinite(Number(hideAfterTick)) && Number(hideAfterTick) > 0 && tick > Number(hideAfterTick)) {
    return null;
  }
  if (Number.isFinite(Number(track.end_tick)) && tick > Number(track.end_tick)) return null;
  let chosen = null;
  for (const sample of track.samples) {
    if (Number(sample.tick) <= tick) chosen = sample;
    else break;
  }
  return chosen;
}

function selectNextSample(track, currentTick) {
  if (!track || !Array.isArray(track.samples)) return null;
  const tick = Number(currentTick);
  if (!Number.isFinite(tick)) return null;
  for (const sample of track.samples) {
    const sampleTick = Number(sample.tick);
    if (Number.isFinite(sampleTick) && sampleTick > tick) return sample;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function filterCellsForMapLayer(cells, transform, mapLayer) {
  const filtered = [];
  for (const cell of cells || []) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const point = { x: cell[0], y: cell[1], z: cell[2] };
    if (!pointMatchesMapLayer(point, transform, mapLayer)) continue;
    filtered.push(cell);
  }
  return filtered;
}

function projectLayerCells(layer, transform, mapLayer, width, height) {
  const projected = [];
  for (const cell of layer.cells) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const point = { x: cell[0], y: cell[1], z: cell[2] };
    if (!pointMatchesMapLayer(point, transform, mapLayer)) continue;
    const percent = worldToPercent(point, transform);
    if (!percent) continue;
    projected.push({
      cx: (percent.x / 100) * width,
      cy: (percent.y / 100) * height,
      intensity: Number(cell[3]),
    });
  }
  return projected;
}

function averageCellDensity(cells) {
  if (!cells?.length) return 0.85;
  let sum = 0;
  let count = 0;
  for (const cell of cells) {
    const d = Number(cell?.[3]);
    if (!Number.isFinite(d)) continue;
    sum += d;
    count += 1;
  }
  return count ? sum / count : 0.85;
}

function worldRingToCanvasPath(ring, transform, width, height) {
  const points = [];
  for (const pt of ring) {
    const percent = worldToPercent({ x: pt[0], y: pt[1] }, transform);
    if (!percent) continue;
    points.push({
      x: (percent.x / 100) * width,
      y: (percent.y / 100) * height,
    });
  }
  return points;
}

function fillSmokeRings(ctx, rings, transform, width, height, alpha) {
  if (!rings?.length || alpha <= 0) return;
  const fillAlpha = clamp(0.45 + 0.35 * alpha, 0.2, 0.85);
  ctx.fillStyle = `rgba(148, 163, 184, ${fillAlpha})`;
  for (const ring of rings) {
    const points = worldRingToCanvasPath(ring, transform, width, height);
    if (points.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function buildSmokeContourRings(cells, cellSize) {
  if (!cells?.length) return [];
  const mask = smoothMask(supersampleMask(buildDensityMask(cells, cellSize), 2), 0.35);
  const { rings } = marchingSquares(mask, SMOKE_CONTOUR_THRESHOLD);
  return rings;
}

function drawSmokeContours(ctx, track, currentTick, transform, mapLayer, width, height, hideAfterTick) {
  const active = selectActiveSample(track, currentTick, hideAfterTick);
  if (!active?.cells?.length) return;

  const cellSize = Number(active.cell_size || track.cell_size || DEFAULT_SMOKE_CELL_SIZE);
  const next = selectNextSample(track, currentTick);
  const activeCells = filterCellsForMapLayer(active.cells, transform, mapLayer);
  if (!activeCells.length) return;

  const activeDensity = averageCellDensity(activeCells);
  const activeRings = buildSmokeContourRings(activeCells, cellSize);

  if (next?.cells?.length) {
    const nextCells = filterCellsForMapLayer(next.cells, transform, mapLayer);
    const { prevA, nextA } = sampleCrossfadeAlpha(
      Number(active.tick),
      Number(next.tick),
      Number(currentTick),
    );
    if (prevA > 0) {
      fillSmokeRings(ctx, activeRings, transform, width, height, prevA * activeDensity);
    }
    if (nextCells.length && nextA > 0) {
      const nextDensity = averageCellDensity(nextCells);
      const nextRings = buildSmokeContourRings(nextCells, Number(next.cell_size || cellSize));
      fillSmokeRings(ctx, nextRings, transform, width, height, nextA * nextDensity);
    }
  } else {
    fillSmokeRings(ctx, activeRings, transform, width, height, activeDensity);
  }
}

function drawRadarSquareCells(ctx, projected, cellSize, transform, width, height) {
  const halfExtentPct = worldRadiusToPercent(cellSize / 2, transform);
  const halfExtentPx = Math.max(1, (halfExtentPct / 100) * Math.min(width, height));
  for (const item of projected) {
    ctx.fillStyle = "rgba(148, 163, 184, 0.45)";
    ctx.strokeStyle = "rgba(203, 213, 225, 0.85)";
    ctx.lineWidth = 1;
    ctx.fillRect(item.cx - halfExtentPx, item.cy - halfExtentPx, halfExtentPx * 2, halfExtentPx * 2);
    ctx.strokeRect(item.cx - halfExtentPx, item.cy - halfExtentPx, halfExtentPx * 2, halfExtentPx * 2);
  }
}

function drawDetonationCrosshair(ctx, detonation, transform, mapLayer, width, height) {
  if (!Array.isArray(detonation) || detonation.length < 3) return;
  const point = { x: detonation[0], y: detonation[1], z: detonation[2] };
  if (!pointMatchesMapLayer(point, transform, mapLayer)) return;
  const percent = worldToPercent(point, transform);
  if (!percent) return;
  const cx = (percent.x / 100) * width;
  const cy = (percent.y / 100) * height;
  const size = 6;
  ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - size, cy);
  ctx.lineTo(cx + size, cy);
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx, cy + size);
  ctx.stroke();
}

/**
 * Canvas overlay for sparse smoke / inferno area cells from /demo/replay effect_tracks.
 * Smoke uses density-mask marching-squares contours; fire stays orange radial blooms.
 */
export default function ReplayAreaEffectsCanvas({
  tracks = [],
  currentTick = 0,
  hideAfterTick = null,
  tickRate = 64,
  transform = null,
  mapLayer = "upper",
  enabled = true,
  capabilities = null,
  smokeDebugLayer = "off",
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const lastSignatureRef = useRef("");

  const activeLayers = useMemo(() => {
    if (!enabled || !Array.isArray(tracks) || !tracks.length) return [];
    const layers = [];
    for (const track of tracks) {
      if (track?.type === "smoke" && capabilities && capabilities.smoke_voxels === false) continue;
      if (track?.type === "inferno" && capabilities && capabilities.inferno_cells === false) continue;
      const sample = selectActiveSample(track, currentTick, hideAfterTick);
      if (!sample?.cells?.length) continue;
      layers.push({
        id: String(track.id || `${track.type}:${track.entity_id}`),
        type: track.type,
        track,
        cellSize: Number(sample.cell_size || track.cell_size || DEFAULT_SMOKE_CELL_SIZE),
        cells: sample.cells,
        sampleTick: Number(sample.tick),
        detonation: sample.detonation_pos || sample.detonation || null,
      });
    }
    return layers;
  }, [tracks, currentTick, hideAfterTick, enabled, capabilities]);

  const signature = useMemo(
    () => JSON.stringify({
      mapLayer,
      smokeDebugLayer,
      currentTick,
      layers: activeLayers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        sampleTick: layer.sampleTick,
        cellSize: layer.cellSize,
        n: layer.cells.length,
      })),
      scale: transform?.scale,
      pos_x: transform?.pos_x,
      pos_y: transform?.pos_y,
    }),
    [activeLayers, mapLayer, transform, smokeDebugLayer, currentTick],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    const paint = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!transform || !activeLayers.length) {
        lastSignatureRef.current = signature;
        return;
      }

      const useSquareDebug = smokeDebugLayer === "radar_cells" || smokeDebugLayer === "world_cells";

      for (const layer of activeLayers) {
        if (useSquareDebug && layer.type === "smoke") {
          const projected = projectLayerCells(layer, transform, mapLayer, width, height);
          if (!projected.length) continue;
          ctx.save();
          drawRadarSquareCells(ctx, projected, layer.cellSize, transform, width, height);
          if (smokeDebugLayer === "world_cells") {
            drawDetonationCrosshair(ctx, layer.detonation, transform, mapLayer, width, height);
          }
          ctx.restore();
          continue;
        }

        if (layer.type === "smoke") {
          ctx.save();
          drawSmokeContours(ctx, layer.track, currentTick, transform, mapLayer, width, height, hideAfterTick);
          ctx.restore();
          continue;
        }

        const projected = projectLayerCells(layer, transform, mapLayer, width, height);
        if (!projected.length) continue;

        const radiusPct = worldRadiusToPercent(INFERNO_CELL_RADIUS_WORLD, transform);
        const radiusPx = Math.max(2.2, (radiusPct / 100) * Math.min(width, height));

        ctx.save();
        for (const item of projected) {
          const intensity = Number.isFinite(item.intensity) ? clamp(item.intensity, 0.45, 1) : 0.95;
          const alpha = clamp(0.8 + 0.2 * intensity, 0.8, 1);
          const grad = ctx.createRadialGradient(item.cx, item.cy, 0, item.cx, item.cy, radiusPx);
          grad.addColorStop(0, `rgba(254, 243, 199, ${0.9 * alpha})`);
          grad.addColorStop(0.35, `rgba(251, 146, 60, ${0.85 * alpha})`);
          grad.addColorStop(0.75, `rgba(249, 115, 22, ${0.45 * alpha})`);
          grad.addColorStop(1, "rgba(194, 65, 12, 0)");
          ctx.beginPath();
          ctx.arc(item.cx, item.cy, radiusPx, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.restore();
      }
      lastSignatureRef.current = signature;
    };

    if (lastSignatureRef.current !== signature) paint();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      lastSignatureRef.current = "";
      paint();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [signature, activeLayers, transform, mapLayer, smokeDebugLayer, currentTick, hideAfterTick]);

  if (!enabled) return null;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[8]" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
