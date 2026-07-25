import { useEffect, useMemo, useRef, useState } from "react";
import { getDemoUtilityMaskUrl } from "../../api/api";
import {
  buildDensityMask,
  dilateMask,
  marchingSquares,
  sampleCrossfadeAlpha,
  smoothMask,
  supersampleMask,
} from "./smokeContour";
import { worldLengthToRadarPercent, worldToRadarPercent } from "../../utils/replayRadarTransform";

/** World grid size for fire occupancy squares (mask write), not a painted bloom radius. */
const INFERNO_CELL_SIZE_WORLD = 36;
const DEFAULT_SMOKE_CELL_SIZE = 20;
const SMOKE_CONTOUR_THRESHOLD = 0.15;
const SMOKE_DILATE_CELLS = 1;
const UTILITY_SOFT_BLUR_PX = 1.25;

function worldToPercent(point, transform) {
  return worldToRadarPercent(point, transform);
}

function worldRadiusToPercent(radiusWorld, transform) {
  return worldLengthToRadarPercent(radiusWorld, transform);
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

/**
 * Convert an L-mode / opaque grayscale mask into an alpha mask for destination-in.
 * Browsers decode L PNGs as RGBA(L,L,L,255); destination-in uses source alpha only,
 * so we map luminance → A and set RGB to opaque white.
 * Accepts an Image / canvas / ImageData-like source with width/height and drawable pixels.
 */
function luminancePixelsToAlphaBuffer(srcPixels, sw, sh, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      const sx = Math.min(sw - 1, Math.floor((px / w) * sw));
      const sy = Math.min(sh - 1, Math.floor((py / h) * sh));
      const si = (sy * sw + sx) * 4;
      const di = (py * w + px) * 4;
      const lum = Math.round((srcPixels[si] + srcPixels[si + 1] + srcPixels[si + 2]) / 3);
      out[di] = 255;
      out[di + 1] = 255;
      out[di + 2] = 255;
      out[di + 3] = lum;
    }
  }
  return out;
}

export function luminanceMaskToAlphaCanvas(img, targetW, targetH) {
  if (!img) return null;
  const sw = Number(img.width) || 0;
  const sh = Number(img.height) || 0;
  if (sw <= 0 || sh <= 0) return null;

  const w = Number.isFinite(targetW) && targetW > 0 ? Math.floor(targetW) : sw;
  const h = Number.isFinite(targetH) && targetH > 0 ? Math.floor(targetH) : sh;
  if (w <= 0 || h <= 0) return null;

  // Pure-JS path for ImageData-like / test fixtures (and when DOM canvas is unavailable).
  const srcPixels = img.__pixels || (img.data instanceof Uint8ClampedArray ? img.data : null);
  if (srcPixels) {
    return { width: w, height: h, __pixels: luminancePixelsToAlphaBuffer(srcPixels, sw, sh, w, h) };
  }

  let canvas;
  try {
    canvas = typeof document !== "undefined" && document.createElement
      ? document.createElement("canvas")
      : null;
  } catch {
    canvas = null;
  }
  if (!canvas || typeof canvas.getContext !== "function") return null;

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    // Cross-origin / tainted canvas — fall back to raw draw (clip may be a no-op for L masks).
    return canvas;
  }
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = lum;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Clip drawn utility pixels to the white regions of a radar-derived mask.
 * Missing mask → no-op (caller skips clip).
 * L-mode masks are converted to alpha before destination-in.
 */
export function applyUtilityClip(ctx, maskSource) {
  if (!maskSource || !ctx) return;
  const w = ctx.canvas?.width;
  const h = ctx.canvas?.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const alphaMask = luminanceMaskToAlphaCanvas(maskSource, w, h);
  if (!alphaMask) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(alphaMask, 0, 0, w, h);
  ctx.restore();
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

function fillSmokeRings(ctx, rings, transform, width, height, alpha, { soft = false } = {}) {
  if (!rings?.length || alpha <= 0) return;
  const fillAlpha = soft
    ? clamp(0.18 + 0.2 * alpha, 0.1, 0.4)
    : clamp(0.5 + 0.35 * alpha, 0.28, 0.9);
  ctx.fillStyle = soft
    ? `rgba(148, 163, 184, ${fillAlpha})`
    : `rgba(203, 213, 225, ${fillAlpha})`;
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
  if (!cells?.length) return { core: [], soft: [] };
  const base = buildDensityMask(cells, cellSize);
  const dilated = dilateMask(base, SMOKE_DILATE_CELLS);
  const softMask = smoothMask(supersampleMask(dilateMask(dilated, 1), 2), 0.35);
  const coreMask = smoothMask(supersampleMask(dilated, 2), 0.35);
  return {
    soft: marchingSquares(softMask, SMOKE_CONTOUR_THRESHOLD * 0.7).rings,
    core: marchingSquares(coreMask, SMOKE_CONTOUR_THRESHOLD).rings,
  };
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

  const paintLayer = (rings, alpha) => {
    if (alpha <= 0) return;
    fillSmokeRings(ctx, rings.soft, transform, width, height, alpha, { soft: true });
    fillSmokeRings(ctx, rings.core, transform, width, height, alpha, { soft: false });
  };

  if (next?.cells?.length) {
    const nextCells = filterCellsForMapLayer(next.cells, transform, mapLayer);
    const { prevA, nextA } = sampleCrossfadeAlpha(
      Number(active.tick),
      Number(next.tick),
      Number(currentTick),
    );
    if (prevA > 0) paintLayer(activeRings, prevA * activeDensity);
    if (nextCells.length && nextA > 0) {
      const nextDensity = averageCellDensity(nextCells);
      const nextRings = buildSmokeContourRings(nextCells, Number(next.cell_size || cellSize));
      paintLayer(nextRings, nextA * nextDensity);
    }
  } else {
    paintLayer(activeRings, activeDensity);
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

/** Fire occupancy squares; flicker only modulates color/alpha, not geometry. */
function drawInfernoOccupancy(ctx, projected, cellSize, transform, width, height, currentTick) {
  const sizeWorld = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : INFERNO_CELL_SIZE_WORLD;
  const halfExtentPct = worldRadiusToPercent(sizeWorld / 2, transform);
  const halfExtentPx = Math.max(1, (halfExtentPct / 100) * Math.min(width, height));
  const tick = Number(currentTick) || 0;
  for (const item of projected) {
    const intensity = Number.isFinite(item.intensity) ? clamp(item.intensity, 0.45, 1) : 0.95;
    const flicker = 0.88 + 0.12 * Math.sin(tick * 0.41 + item.cx * 0.02 + item.cy * 0.017);
    const alpha = clamp((0.75 + 0.25 * intensity) * flicker, 0.55, 1);
    ctx.fillStyle = `rgba(249, 115, 22, ${0.72 * alpha})`;
    ctx.fillRect(item.cx - halfExtentPx, item.cy - halfExtentPx, halfExtentPx * 2, halfExtentPx * 2);
    const core = halfExtentPx * 0.45;
    ctx.fillStyle = `rgba(254, 243, 199, ${0.55 * alpha})`;
    ctx.fillRect(item.cx - core, item.cy - core, core * 2, core * 2);
  }
}

function paintEffectLayers(ctx, {
  activeLayers,
  transform,
  mapLayer,
  width,
  height,
  smokeDebugLayer,
  currentTick,
  hideAfterTick,
}) {
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

    if (layer.type !== "inferno") continue;

    const projected = projectLayerCells(layer, transform, mapLayer, width, height);
    if (!projected.length) continue;
    const fireCellSize = Number(layer.cellSize) > 0 ? Number(layer.cellSize) : INFERNO_CELL_SIZE_WORLD;
    ctx.save();
    drawInfernoOccupancy(ctx, projected, fireCellSize, transform, width, height, currentTick);
    ctx.restore();
  }
}

/**
 * When mask is present: clip → soft blur → clip again.
 * First clip prevents blur bleed-in from outside the mask; second clip re-hardens edges.
 * Falls back to direct paint when offscreen canvas / mask is unavailable.
 */
function compositeWithUtilityClip(ctx, width, height, utilityMask, paintFn) {
  if (!utilityMask) {
    paintFn(ctx);
    return;
  }

  let off;
  try {
    off = document.createElement("canvas");
  } catch {
    paintFn(ctx);
    applyUtilityClip(ctx, utilityMask);
    return;
  }

  off.width = Math.max(1, Math.floor(width));
  off.height = Math.max(1, Math.floor(height));
  const octx = off.getContext("2d");
  if (!octx || typeof octx.drawImage !== "function") {
    paintFn(ctx);
    applyUtilityClip(ctx, utilityMask);
    return;
  }

  paintFn(octx);
  // Clip before blur so soft edges cannot bleed in from outside the mask.
  applyUtilityClip(octx, utilityMask);

  let soft = off;
  try {
    const blurred = document.createElement("canvas");
    blurred.width = off.width;
    blurred.height = off.height;
    const bctx = blurred.getContext("2d");
    if (bctx && typeof bctx.drawImage === "function") {
      if ("filter" in bctx) {
        bctx.filter = `blur(${UTILITY_SOFT_BLUR_PX}px)`;
      }
      bctx.drawImage(off, 0, 0);
      if ("filter" in bctx) bctx.filter = "none";
      // Soften then clip again (destination-in).
      applyUtilityClip(bctx, utilityMask);
      soft = blurred;
    }
  } catch {
    // Keep pre-blur clipped offscreen.
  }

  ctx.drawImage(soft, 0, 0);
}

/**
 * Canvas overlay for sparse smoke / inferno area cells from /demo/replay effect_tracks.
 * Smoke uses density-mask marching-squares contours; fire uses occupancy squares + utility clip.
 */
export default function ReplayAreaEffectsCanvas({
  tracks = [],
  currentTick = 0,
  hideAfterTick = null,
  tickRate = 64,
  transform = null,
  mapName = "",
  mapLayer = "upper",
  enabled = true,
  capabilities = null,
  smokeDebugLayer = "off",
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const lastSignatureRef = useRef("");
  const [utilityMask, setUtilityMask] = useState(null);

  useEffect(() => {
    if (!mapName) {
      setUtilityMask(null);
      return undefined;
    }
    const layer = mapLayer || "upper";
    const url = getDemoUtilityMaskUrl(mapName, layer === "upper" ? "" : layer);
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setUtilityMask(img);
    };
    img.onerror = () => {
      // Missing mask → skip clip, do not crash.
      if (!cancelled) setUtilityMask(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [mapName, mapLayer]);

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
        cellSize: Number(
          sample.cell_size
          || track.cell_size
          || (track.type === "inferno" ? INFERNO_CELL_SIZE_WORLD : DEFAULT_SMOKE_CELL_SIZE),
        ),
        cells: sample.cells,
        sampleTick: Number(sample.tick),
        detonation: sample.detonation_pos || sample.detonation || null,
      });
    }
    return layers;
  }, [tracks, currentTick, hideAfterTick, enabled, capabilities]);

  const signature = useMemo(
    () => JSON.stringify({
      mapName,
      mapLayer,
      smokeDebugLayer,
      currentTick,
      hasUtilityMask: Boolean(utilityMask),
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
    [activeLayers, mapName, mapLayer, transform, smokeDebugLayer, currentTick, utilityMask],
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

      const paintArgs = {
        activeLayers,
        transform,
        mapLayer,
        width,
        height,
        smokeDebugLayer,
        currentTick,
        hideAfterTick,
      };

      compositeWithUtilityClip(ctx, width, height, utilityMask, (target) => {
        paintEffectLayers(target, paintArgs);
      });
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
  }, [signature, activeLayers, transform, mapLayer, smokeDebugLayer, currentTick, hideAfterTick, utilityMask]);

  if (!enabled) return null;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[8]" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
