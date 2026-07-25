import { useEffect, useMemo, useRef } from "react";

const MAP_SIZE = 1024;
const INFERNO_CELL_RADIUS_WORLD = 28;
const DEFAULT_SMOKE_CELL_SIZE = 20;

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

export function selectActiveSample(track, currentTick) {
  if (!track || !Array.isArray(track.samples) || !track.samples.length) return null;
  const tick = Number(currentTick);
  if (!Number.isFinite(tick)) return null;
  if (tick < Number(track.start_tick)) return null;
  if (Number.isFinite(Number(track.end_tick)) && tick > Number(track.end_tick)) return null;
  let chosen = null;
  for (const sample of track.samples) {
    if (Number(sample.tick) <= tick) chosen = sample;
    else break;
  }
  return chosen;
}

function paintSoftCell(ctx, cx, cy, radiusPx, stops) {
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
  for (const [stop, color] of stops) gradient.addColorStop(stop, color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Canvas overlay for sparse smoke / inferno area cells from /demo/replay effect_tracks.
 */
export default function ReplayAreaEffectsCanvas({
  tracks = [],
  currentTick = 0,
  transform = null,
  mapLayer = "upper",
  enabled = true,
  capabilities = null,
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
      const sample = selectActiveSample(track, currentTick);
      if (!sample?.cells?.length) continue;
      layers.push({
        id: String(track.id || `${track.type}:${track.entity_id}`),
        type: track.type,
        cellSize: Number(sample.cell_size || track.cell_size || DEFAULT_SMOKE_CELL_SIZE),
        cells: sample.cells,
        sampleTick: Number(sample.tick),
      });
    }
    return layers;
  }, [tracks, currentTick, enabled, capabilities]);

  const signature = useMemo(
    () => JSON.stringify({
      mapLayer,
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
    [activeLayers, mapLayer, transform],
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

      for (const layer of activeLayers) {
        const isSmoke = layer.type === "smoke";
        const radiusWorld = isSmoke ? Math.max(10, layer.cellSize * 0.7) : INFERNO_CELL_RADIUS_WORLD;
        const radiusPct = worldRadiusToPercent(radiusWorld, transform);
        const radiusPx = (radiusPct / 100) * Math.min(width, height);
        ctx.save();
        ctx.globalCompositeOperation = isSmoke ? "source-over" : "lighter";
        for (const cell of layer.cells) {
          if (!Array.isArray(cell) || cell.length < 3) continue;
          const point = { x: cell[0], y: cell[1], z: cell[2] };
          if (!pointMatchesMapLayer(point, transform, mapLayer)) continue;
          const percent = worldToPercent(point, transform);
          if (!percent) continue;
          const cx = (percent.x / 100) * width;
          const cy = (percent.y / 100) * height;
          const intensity = Number(cell[3]);
          const alpha = Number.isFinite(intensity) ? clamp(intensity, 0.15, 1) : 0.85;
          if (isSmoke) {
            paintSoftCell(ctx, cx, cy, radiusPx, [
              [0, `rgba(148,163,184,${0.55 * alpha})`],
              [0.45, `rgba(100,116,139,${0.28 * alpha})`],
              [1, "rgba(71,85,105,0)"],
            ]);
          } else {
            paintSoftCell(ctx, cx, cy, radiusPx, [
              [0, `rgba(255,250,220,${0.95 * alpha})`],
              [0.25, `rgba(251,191,36,${0.75 * alpha})`],
              [0.65, `rgba(249,115,22,${0.45 * alpha})`],
              [1, "rgba(220,38,38,0)"],
            ]);
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
  }, [signature, activeLayers, transform, mapLayer]);

  if (!enabled) return null;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[8]" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
