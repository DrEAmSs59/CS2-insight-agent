import { useEffect, useMemo, useRef } from "react";

const MAP_SIZE = 1024;
const INFERNO_CELL_RADIUS_WORLD = 36;
const DEFAULT_SMOKE_CELL_SIZE = 20;
const SMOKE_CELL_RADIUS_WORLD = 28;
const SMOKE_BLOOM_SECONDS = 1.35;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function smokeBloomFactor(track, currentTick, tickRate) {
  const start = Number(track?.start_tick);
  const tick = Number(currentTick);
  const rate = Math.max(1, Number(tickRate) || 64);
  if (!Number.isFinite(start) || !Number.isFinite(tick)) return 1;
  const ageSec = Math.max(0, (tick - start) / rate);
  const t = clamp(ageSec / SMOKE_BLOOM_SECONDS, 0, 1);
  return 0.2 + (1 - 0.2) * (1 - (1 - t) * (1 - t));
}

/**
 * Canvas overlay for sparse smoke / inferno area cells from /demo/replay effect_tracks.
 * Smoke uses soft radial gradients (same language as fire) in gray; fire stays orange.
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
      const bloom = track?.type === "smoke" ? smokeBloomFactor(track, currentTick, tickRate) : 1;
      layers.push({
        id: String(track.id || `${track.type}:${track.entity_id}`),
        type: track.type,
        cellSize: Number(sample.cell_size || track.cell_size || DEFAULT_SMOKE_CELL_SIZE),
        cells: sample.cells,
        sampleTick: Number(sample.tick),
        bloom,
        detonation: sample.detonation_pos || sample.detonation || null,
      });
    }
    return layers;
  }, [tracks, currentTick, hideAfterTick, enabled, capabilities, tickRate]);

  const signature = useMemo(
    () => JSON.stringify({
      mapLayer,
      smokeDebugLayer,
      layers: activeLayers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        sampleTick: layer.sampleTick,
        cellSize: layer.cellSize,
        n: layer.cells.length,
        bloom: Number(layer.bloom?.toFixed?.(3) || layer.bloom),
      })),
      scale: transform?.scale,
      pos_x: transform?.pos_x,
      pos_y: transform?.pos_y,
    }),
    [activeLayers, mapLayer, transform, smokeDebugLayer],
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
        const projected = projectLayerCells(layer, transform, mapLayer, width, height);
        if (!projected.length) continue;

        if (useSquareDebug) {
          ctx.save();
          drawRadarSquareCells(ctx, projected, layer.cellSize, transform, width, height);
          if (smokeDebugLayer === "world_cells") {
            drawDetonationCrosshair(ctx, layer.detonation, transform, mapLayer, width, height);
          }
          ctx.restore();
          continue;
        }

        const isSmoke = layer.type === "smoke";
        const bloom = isSmoke ? clamp(Number(layer.bloom) || 1, 0.15, 1) : 1;
        const radiusWorld = isSmoke ? SMOKE_CELL_RADIUS_WORLD : INFERNO_CELL_RADIUS_WORLD;
        const radiusPct = worldRadiusToPercent(radiusWorld, transform);
        const radiusPx = Math.max(2.2, (radiusPct / 100) * Math.min(width, height));

        let centerX = 0;
        let centerY = 0;
        for (const item of projected) {
          centerX += item.cx;
          centerY += item.cy;
        }
        centerX /= projected.length;
        centerY /= projected.length;
        let maxDist = 1;
        for (const item of projected) {
          maxDist = Math.max(maxDist, Math.hypot(item.cx - centerX, item.cy - centerY));
        }
        const bloomRadius = maxDist * bloom + radiusPx * 0.4;

        ctx.save();
        for (const item of projected) {
          const dist = Math.hypot(item.cx - centerX, item.cy - centerY);
          if (isSmoke && dist > bloomRadius) continue;
          const intensity = Number.isFinite(item.intensity) ? clamp(item.intensity, 0.45, 1) : 0.95;
          if (isSmoke) {
            const alpha = clamp(0.55 + 0.35 * intensity, 0.55, 0.9) * (0.7 + 0.3 * bloom);
            const grad = ctx.createRadialGradient(item.cx, item.cy, 0, item.cx, item.cy, radiusPx);
            grad.addColorStop(0, `rgba(203, 213, 225, ${0.75 * alpha})`);
            grad.addColorStop(0.4, `rgba(148, 163, 184, ${0.55 * alpha})`);
            grad.addColorStop(0.75, `rgba(100, 116, 139, ${0.28 * alpha})`);
            grad.addColorStop(1, "rgba(71, 85, 105, 0)");
            ctx.beginPath();
            ctx.arc(item.cx, item.cy, radiusPx, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
          } else {
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
  }, [signature, activeLayers, transform, mapLayer, smokeDebugLayer]);

  if (!enabled) return null;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[8]" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
