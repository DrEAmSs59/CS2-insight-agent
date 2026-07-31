/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  buildDensityMask,
  dilateMask,
  marchingSquares,
  sampleCrossfadeAlpha,
  smoothMask,
  supersampleMask,
} from "./smokeContour";
import { worldLengthToRadarPercent, worldToRadarPercent } from "../../utils/replayRadarTransform";
import {
  clamp,
  DEFAULT_SMOKE_CELL_SIZE,
  effectPalette,
  hashString,
  hashUnit,
  INFERNO_CELL_SIZE_WORLD,
  infernoFlameGeometry,
  smokeParticleState,
} from "./replayAreaEffectsModel";
import {
  applyUtilityClip,
  luminanceMaskToAlphaCanvas,
  makeCanvas,
  resizeCanvas,
} from "./replayAreaEffectsMask";

export {
  activeEffectLayerSignature,
  buildActiveEffectLayers,
  DEFAULT_SMOKE_CELL_SIZE,
  effectPalette,
  INFERNO_CELL_SIZE_WORLD,
  infernoFlameGeometry,
  selectActiveSample,
  selectSamplePair,
  smokeParticleState,
} from "./replayAreaEffectsModel";
export { applyUtilityClip, luminanceMaskToAlphaCanvas } from "./replayAreaEffectsMask";

const SMOKE_CONTOUR_THRESHOLD = 0.15;
const SMOKE_DILATE_CELLS = 1;
const MAX_GEOMETRY_CACHE_ENTRIES = 256;
const SMOKE_PARTICLE_MIN = 48;
const SMOKE_PARTICLE_MAX = 128;
const INFERNO_POINT_VISUAL_SCALE = 2.25;
const INFERNO_POINT_MIN_HALF_EXTENT_PX = 5.5;

export function infernoPointHalfExtentPx(cellSize, transform, width, height) {
  const sizeWorld = Number(cellSize) > 0 ? Number(cellSize) : INFERNO_CELL_SIZE_WORLD;
  const halfExtentPct = worldLengthToRadarPercent(sizeWorld / 2, transform);
  const occupancyHalfExtentPx = Math.max(1, (halfExtentPct / 100) * Math.min(width, height));
  return Math.max(
    INFERNO_POINT_MIN_HALF_EXTENT_PX,
    occupancyHalfExtentPx * INFERNO_POINT_VISUAL_SCALE,
  );
}

function mapLayerThreshold(transform) {
  const value = Number(transform?.lower_level_max_units);
  return Number.isFinite(value) ? value : null;
}

function pointMatchesMapLayer(point, transform, mapLayer) {
  const threshold = mapLayerThreshold(transform);
  if (threshold == null || !mapLayer) return true;
  const rawZ = point?.z;
  if (rawZ == null || rawZ === "") return false;
  const z = Number(rawZ);
  if (!Number.isFinite(z)) return false;
  return mapLayer === "lower" ? z <= threshold : z > threshold;
}

function filterCellsForMapLayer(cells, transform, mapLayer) {
  const filtered = [];
  for (const cell of cells || []) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const point = { x: cell[0], y: cell[1], z: cell[2] };
    if (pointMatchesMapLayer(point, transform, mapLayer)) filtered.push(cell);
  }
  return filtered;
}

function projectCells(cells, transform, mapLayer, width, height) {
  const projected = [];
  for (const cell of cells || []) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const point = { x: cell[0], y: cell[1], z: cell[2] };
    if (!pointMatchesMapLayer(point, transform, mapLayer)) continue;
    const percent = worldToRadarPercent(point, transform);
    if (!percent) continue;
    projected.push({
      cx: (percent.x / 100) * width,
      cy: (percent.y / 100) * height,
      intensity: Number(cell[3]),
      seed: Number(cell[0]) * 0.017 + Number(cell[1]) * 0.013,
    });
  }
  return projected;
}

function averageCellDensity(cells) {
  if (!cells?.length) return 0.85;
  let sum = 0;
  let count = 0;
  for (const cell of cells) {
    const density = Number(cell?.[3]);
    if (!Number.isFinite(density)) continue;
    sum += density;
    count += 1;
  }
  return count ? sum / count : 0.85;
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

function worldRingsToCanvas(rings, transform, width, height) {
  const canvasRings = [];
  for (const ring of rings || []) {
    const points = [];
    for (const point of ring) {
      const percent = worldToRadarPercent({ x: point[0], y: point[1] }, transform);
      if (!percent) continue;
      points.push({ x: (percent.x / 100) * width, y: (percent.y / 100) * height });
    }
    if (points.length >= 3) canvasRings.push(points);
  }
  return canvasRings;
}

function ringsToPath(rings) {
  if (typeof Path2D === "undefined") return null;
  const path = new Path2D();
  for (const points of rings || []) {
    if (points.length < 3) continue;
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
    path.closePath();
  }
  return path;
}

function traceRings(ctx, rings) {
  ctx.beginPath();
  for (const points of rings || []) {
    if (points.length < 3) continue;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }
}

function fillGeometryPath(ctx, geometry, fillStyle) {
  if (!geometry?.rings?.length) return;
  ctx.fillStyle = fillStyle;
  if (geometry.path) {
    ctx.fill(geometry.path);
    return;
  }
  traceRings(ctx, geometry.rings);
  ctx.fill();
}

function clipGeometryPath(ctx, geometry) {
  if (typeof ctx.clip !== "function" || !geometry?.rings?.length) return false;
  if (geometry.path) ctx.clip(geometry.path);
  else {
    traceRings(ctx, geometry.rings);
    ctx.clip();
  }
  return true;
}

function transformCacheKey(transform, mapLayer, width, height) {
  return [
    mapLayer,
    width,
    height,
    transform?.scale,
    transform?.pos_x,
    transform?.pos_y,
    transform?.rotate,
    transform?.lower_level_max_units,
  ].join(":");
}

function insertCapped(cache, key, value) {
  cache.set(key, value);
  if (cache.size > MAX_GEOMETRY_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

function makeSmokeSprite(palette) {
  const canvas = makeCanvas(48, 48);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx || typeof ctx.createRadialGradient !== "function") return null;
  const [r, g, b] = palette.smokeCore;
  const [sr, sg, sb] = palette.smokeSoft;
  const gradient = ctx.createRadialGradient(24, 24, 1, 24, 24, 23);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.28)`);
  gradient.addColorStop(0.45, `rgba(${sr}, ${sg}, ${sb}, 0.16)`);
  gradient.addColorStop(1, `rgba(${sr}, ${sg}, ${sb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 48, 48);
  return canvas;
}

function makeFireSprite(palette) {
  const canvas = makeCanvas(48, 48);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx || typeof ctx.createRadialGradient !== "function") return null;
  const [hot, bright, middle, outer] = palette.fire;
  const gradient = ctx.createRadialGradient(24, 24, 1, 24, 24, 23);
  gradient.addColorStop(0, `rgba(${hot.join(", ")}, 0.98)`);
  gradient.addColorStop(0.28, `rgba(${bright.join(", ")}, 0.9)`);
  gradient.addColorStop(0.62, `rgba(${middle.join(", ")}, 0.64)`);
  gradient.addColorStop(1, `rgba(${outer.join(", ")}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 48, 48);
  return canvas;
}

function fillCircle(ctx, x, y, radius, color) {
  if (!(radius > 0) || typeof ctx.arc !== "function") return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawRadarSquareCells(ctx, projected, cellSize, transform, width, height, palette) {
  const halfExtentPct = worldLengthToRadarPercent(cellSize / 2, transform);
  const halfExtentPx = Math.max(1, (halfExtentPct / 100) * Math.min(width, height));
  const [softRed, softGreen, softBlue] = palette.smokeSoft;
  const [coreRed, coreGreen, coreBlue] = palette.smokeCore;
  for (const item of projected) {
    ctx.fillStyle = `rgba(${softRed}, ${softGreen}, ${softBlue}, 0.45)`;
    ctx.strokeStyle = `rgba(${coreRed}, ${coreGreen}, ${coreBlue}, 0.85)`;
    ctx.lineWidth = 1;
    ctx.fillRect(item.cx - halfExtentPx, item.cy - halfExtentPx, halfExtentPx * 2, halfExtentPx * 2);
    ctx.strokeRect?.(item.cx - halfExtentPx, item.cy - halfExtentPx, halfExtentPx * 2, halfExtentPx * 2);
  }
}

function drawDetonationCrosshair(ctx, detonation, transform, mapLayer, width, height) {
  if (!Array.isArray(detonation) || detonation.length < 3) return;
  const point = { x: detonation[0], y: detonation[1], z: detonation[2] };
  if (!pointMatchesMapLayer(point, transform, mapLayer)) return;
  const percent = worldToRadarPercent(point, transform);
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
  ctx.stroke?.();
}

export function createAreaEffectsRenderer() {
  const smokeGeometryCache = new Map();
  const projectedGeometryCache = new Map();
  const spriteCache = new Map();
  const stats = {
    smokeGeometryBuilds: 0,
    projectedGeometryBuilds: 0,
    utilityMaskBuilds: 0,
  };
  let utilityMask = null;
  let utilityAlpha = null;
  let utilityAlphaKey = "";
  let sceneCanvas = null;
  let sceneContext = null;

  const getSmokeGeometry = (layer, sample, transform, mapLayer, width, height) => {
    const cacheKey = [
      layer.id,
      Number(sample?.tick),
      Number(sample?.cell_size || layer.cellSize),
      transformCacheKey(transform, mapLayer, width, height),
    ].join("|");
    const cached = smokeGeometryCache.get(cacheKey);
    if (cached) return cached;

    const cells = filterCellsForMapLayer(sample?.cells, transform, mapLayer);
    const cellSize = Number(sample?.cell_size || layer.cellSize || DEFAULT_SMOKE_CELL_SIZE);
    const worldRings = buildSmokeContourRings(cells, cellSize);
    const softRings = worldRingsToCanvas(worldRings.soft, transform, width, height);
    const coreRings = worldRingsToCanvas(worldRings.core, transform, width, height);
    const projected = projectCells(cells, transform, mapLayer, width, height);
    const particleCount = clamp(Math.round(Math.sqrt(projected.length) * 4), SMOKE_PARTICLE_MIN, SMOKE_PARTICLE_MAX);
    const particleBases = [];
    if (projected.length) {
      const seed = hashString(`${layer.id}:${Number(sample?.tick)}`);
      for (let i = 0; i < particleCount; i += 1) {
        const index = Math.floor(hashUnit(seed + Math.imul(i + 1, 2654435761)) * projected.length);
        particleBases.push(projected[Math.min(projected.length - 1, index)]);
      }
    }
    const geometry = {
      density: averageCellDensity(cells),
      soft: { rings: softRings, path: ringsToPath(softRings) },
      core: { rings: coreRings, path: ringsToPath(coreRings) },
      projected,
      particleBases,
      particleRadius: Math.max(
        2,
        (worldLengthToRadarPercent(cellSize * 1.2, transform) / 100) * Math.min(width, height),
      ),
    };
    stats.smokeGeometryBuilds += 1;
    return insertCapped(smokeGeometryCache, cacheKey, geometry);
  };

  const getProjectedGeometry = (layer, sample, transform, mapLayer, width, height) => {
    const cacheKey = [
      layer.id,
      Number(sample?.tick),
      transformCacheKey(transform, mapLayer, width, height),
    ].join("|");
    const cached = projectedGeometryCache.get(cacheKey);
    if (cached) return cached;
    stats.projectedGeometryBuilds += 1;
    return insertCapped(
      projectedGeometryCache,
      cacheKey,
      projectCells(sample?.cells, transform, mapLayer, width, height),
    );
  };

  const getSprite = (type, side) => {
    const key = `${type}:${String(side || "unknown").toUpperCase()}`;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const palette = effectPalette(side);
    const sprite = type === "smoke" ? makeSmokeSprite(palette) : makeFireSprite(palette);
    spriteCache.set(key, sprite);
    return sprite;
  };

  const drawSmokeParticles = (ctx, layer, geometry, alpha, currentTick, tickRate) => {
    if (alpha <= 0 || typeof ctx.drawImage !== "function" || !geometry.particleBases.length) return;
    const sprite = getSprite("smoke", layer.side);
    if (!sprite) return;
    ctx.save();
    if (!clipGeometryPath(ctx, geometry.core)) {
      ctx.restore();
      return;
    }
    ctx.globalCompositeOperation = "screen";
    const trackSeed = hashString(`${layer.id}:${Number(layer.activeSample?.tick)}`);
    for (let i = 0; i < geometry.particleBases.length; i += 1) {
      const state = smokeParticleState(
        trackSeed,
        i,
        currentTick,
        geometry.particleBases[i],
        geometry.particleRadius,
        tickRate,
      );
      const radius = Math.max(1, state.radius);
      ctx.globalAlpha = alpha * state.alpha;
      ctx.drawImage(sprite, state.x - radius, state.y - radius, radius * 2, radius * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  };

  const paintSmokeGeometry = (ctx, layer, geometry, alpha, currentTick, tickRate) => {
    if (!geometry || alpha <= 0) return;
    const palette = effectPalette(layer.side);
    const amount = clamp(alpha, 0, 1) * geometry.density;
    const softAlpha = clamp((0.14 + 0.14 * geometry.density) * alpha, 0, 0.32);
    const coreAlpha = clamp((0.42 + 0.22 * geometry.density) * alpha, 0, 0.72);
    fillGeometryPath(
      ctx,
      geometry.soft,
      `rgba(${palette.smokeSoft.join(", ")}, ${softAlpha})`,
    );
    fillGeometryPath(
      ctx,
      geometry.core,
      `rgba(${palette.smokeCore.join(", ")}, ${coreAlpha})`,
    );
    drawSmokeParticles(ctx, layer, geometry, amount, currentTick, tickRate);
  };

  const drawInferno = (ctx, layer, projected, transform, width, height, currentTick) => {
    if (!projected.length) return;
    const sizeWorld = Number(layer.cellSize) > 0 ? Number(layer.cellSize) : INFERNO_CELL_SIZE_WORLD;
    const halfExtentPx = infernoPointHalfExtentPx(sizeWorld, transform, width, height);
    const palette = effectPalette(layer.side);
    const [hot, bright, middle, outer] = palette.fire;
    const sprite = typeof ctx.drawImage === "function" ? getSprite("fire", layer.side) : null;

    // One batched, slightly overlapping bed removes the checkerboard gaps
    // between neighbouring CInferno cells while retaining their true outline.
    if (typeof ctx.arc === "function" && typeof ctx.moveTo === "function") {
      ctx.fillStyle = `rgba(${middle.join(", ")}, 0.28)`;
      ctx.beginPath();
      const bedRadius = halfExtentPx * 1.28;
      for (const item of projected) {
        ctx.moveTo(item.cx + bedRadius, item.cy);
        ctx.arc(item.cx, item.cy, bedRadius, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    for (const item of projected) {
      const shape = infernoFlameGeometry(item, currentTick, halfExtentPx);
      const intensity = Number.isFinite(item.intensity) ? clamp(item.intensity, 0.45, 1) : 0.95;
      if (sprite) {
        const radius = shape.outerRadius;
        ctx.globalAlpha = (0.66 + 0.28 * intensity) * shape.pulse;
        ctx.drawImage(
          sprite,
          item.cx + shape.jitterX - radius,
          item.cy + shape.jitterY - radius,
          radius * 2,
          radius * 2,
        );
        const coreRadius = shape.middleRadius * 1.08;
        ctx.globalAlpha = (0.3 + 0.25 * intensity) * shape.pulse;
        ctx.drawImage(
          sprite,
          item.cx - coreRadius,
          item.cy - coreRadius,
          coreRadius * 2,
          coreRadius * 2,
        );
        ctx.globalAlpha = 1;
      } else {
        fillCircle(
          ctx,
          item.cx + shape.jitterX,
          item.cy + shape.jitterY,
          shape.outerRadius,
          `rgba(${outer.join(", ")}, ${0.34 + 0.2 * intensity})`,
        );
        fillCircle(
          ctx,
          item.cx,
          item.cy,
          shape.middleRadius,
          `rgba(${middle.join(", ")}, ${(0.48 + 0.25 * intensity) * shape.pulse})`,
        );
        fillCircle(
          ctx,
          item.cx - shape.jitterX * 0.2,
          item.cy - shape.jitterY * 0.2,
          shape.coreRadius,
          `rgba(${bright.join(", ")}, ${0.68 + 0.2 * intensity})`,
        );
      }
      if (sprite) {
        const sparkRadius = shape.sparkRadius * 1.35;
        ctx.globalAlpha = 0.44 + 0.28 * shape.pulse;
        ctx.drawImage(
          sprite,
          item.cx + shape.sparkX - sparkRadius,
          item.cy + shape.sparkY - sparkRadius,
          sparkRadius * 2,
          sparkRadius * 2,
        );
        ctx.globalAlpha = 1;
      } else {
        fillCircle(
          ctx,
          item.cx + shape.sparkX,
          item.cy + shape.sparkY,
          shape.sparkRadius,
          `rgba(${hot.join(", ")}, ${0.44 + 0.28 * shape.pulse})`,
        );
      }
    }
  };

  const paintLayers = (ctx, options) => {
    const {
      layers,
      transform,
      mapLayer,
      width,
      height,
      smokeDebugLayer,
      currentTick,
      tickRate,
    } = options;
    const squareDebug = smokeDebugLayer === "radar_cells" || smokeDebugLayer === "world_cells";
    for (const layer of layers || []) {
      if (layer.type === "smoke") {
        const activeGeometry = getSmokeGeometry(
          layer,
          layer.activeSample,
          transform,
          mapLayer,
          width,
          height,
        );
        if (squareDebug) {
          drawRadarSquareCells(
            ctx,
            activeGeometry.projected,
            layer.cellSize,
            transform,
            width,
            height,
            effectPalette(layer.side),
          );
          if (smokeDebugLayer === "world_cells") {
            drawDetonationCrosshair(ctx, layer.detonation, transform, mapLayer, width, height);
          }
          continue;
        }

        const next = layer.nextSample;
        if (next?.cells?.length) {
          const { prevA, nextA } = sampleCrossfadeAlpha(
            Number(layer.activeSample.tick),
            Number(next.tick),
            Number(currentTick),
          );
          if (prevA > 0) paintSmokeGeometry(ctx, layer, activeGeometry, prevA, currentTick, tickRate);
          if (nextA > 0) {
            const nextGeometry = getSmokeGeometry(layer, next, transform, mapLayer, width, height);
            paintSmokeGeometry(ctx, layer, nextGeometry, nextA, currentTick, tickRate);
          }
        } else {
          paintSmokeGeometry(ctx, layer, activeGeometry, 1, currentTick, tickRate);
        }
        continue;
      }

      if (layer.type !== "inferno") continue;
      const projected = getProjectedGeometry(
        layer,
        layer.activeSample,
        transform,
        mapLayer,
        width,
        height,
      );
      drawInferno(ctx, layer, projected, transform, width, height, currentTick);
    }
  };

  const ensureScene = (width, height) => {
    if (!sceneCanvas) {
      sceneCanvas = makeCanvas(width, height);
      sceneContext = sceneCanvas?.getContext?.("2d") || null;
    }
    if (!sceneCanvas || !sceneContext) return null;
    resizeCanvas(sceneCanvas, width, height);
    return sceneContext;
  };

  const prepareUtilityAlpha = (width, height) => {
    if (!utilityMask) return null;
    const key = `${width}x${height}`;
    if (utilityAlpha && utilityAlphaKey === key) return utilityAlpha;
    utilityAlpha = luminanceMaskToAlphaCanvas(utilityMask, width, height);
    utilityAlphaKey = key;
    stats.utilityMaskBuilds += 1;
    return utilityAlpha;
  };

  return {
    setUtilityMask(mask) {
      if (utilityMask === mask) return;
      utilityMask?.close?.();
      utilityMask = mask || null;
      utilityAlpha = null;
      utilityAlphaKey = "";
    },

    clearGeometryCache() {
      smokeGeometryCache.clear();
      projectedGeometryCache.clear();
    },

    getStats() {
      return { ...stats };
    },

    render(ctx, options) {
      const width = Math.max(1, Number(options?.width) || 1);
      const height = Math.max(1, Number(options?.height) || 1);
      if (!ctx || !options?.transform || !options?.layers?.length) return;

      // Production drawing always uses a persistent CSS-pixel surface. This
      // caps effect cost independently of display DPR and avoids per-frame canvases.
      if (typeof ctx.drawImage === "function") {
        const target = ensureScene(width, height);
        if (target && typeof target.drawImage === "function") {
          target.setTransform?.(1, 0, 0, 1, 0, 0);
          target.clearRect(0, 0, width, height);
          paintLayers(target, { ...options, width, height });
          if (utilityMask) {
            const alphaMask = prepareUtilityAlpha(width, height);
            if (alphaMask) applyUtilityClip(target, utilityMask, alphaMask);
          }
          ctx.drawImage(sceneCanvas, 0, 0, width, height);
          return;
        }
      }
      paintLayers(ctx, { ...options, width, height });
    },
  };
}
