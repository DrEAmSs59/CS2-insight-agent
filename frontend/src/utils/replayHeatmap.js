import { worldToRadarPercent } from "./replayRadarTransform";

export const REPLAY_HEATMAP_GRID_SIZE = 48;
const MOVEMENT_SAMPLE_HZ = 4;

export function createHeatmapGrid(size = REPLAY_HEATMAP_GRID_SIZE) {
  return {
    size,
    values: new Float32Array(size * size),
    sampleCount: 0,
    eventCount: 0,
  };
}

export function depositHeatmapPoint(grid, xPercent, yPercent, weight = 1) {
  const size = Number(grid?.size) || 0;
  const values = grid?.values;
  const x = Number(xPercent);
  const y = Number(yPercent);
  const resolvedWeight = Number(weight);
  if (
    size < 2
    || !(values instanceof Float32Array)
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || x < 0
    || x > 100
    || y < 0
    || y > 100
    || !Number.isFinite(resolvedWeight)
    || resolvedWeight <= 0
  ) {
    return false;
  }

  // Cloud-in-cell deposition is the Q1 finite-element equivalent: a sample
  // contributes bilinearly to the four surrounding grid nodes.
  const gridX = (x / 100) * (size - 1);
  const gridY = (y / 100) * (size - 1);
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = gridX - x0;
  const fy = gridY - y0;
  values[y0 * size + x0] += resolvedWeight * (1 - fx) * (1 - fy);
  values[y0 * size + x1] += resolvedWeight * fx * (1 - fy);
  values[y1 * size + x0] += resolvedWeight * (1 - fx) * fy;
  values[y1 * size + x1] += resolvedWeight * fx * fy;
  grid.sampleCount += 1;
  return true;
}

function smoothGridValues(values, size, passes = 2) {
  let source = new Float32Array(values);
  let horizontal = new Float32Array(values.length);
  let vertical = new Float32Array(values.length);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < size; y += 1) {
      const row = y * size;
      for (let x = 0; x < size; x += 1) {
        const left = source[row + Math.max(0, x - 1)];
        const center = source[row + x];
        const right = source[row + Math.min(size - 1, x + 1)];
        horizontal[row + x] = (left + center * 2 + right) / 4;
      }
    }
    for (let y = 0; y < size; y += 1) {
      const previousRow = Math.max(0, y - 1) * size;
      const row = y * size;
      const nextRow = Math.min(size - 1, y + 1) * size;
      for (let x = 0; x < size; x += 1) {
        vertical[row + x] = (
          horizontal[previousRow + x]
          + horizontal[row + x] * 2
          + horizontal[nextRow + x]
        ) / 4;
      }
    }
    source = vertical;
    vertical = new Float32Array(values.length);
  }
  return source;
}

function normalizeGrid(grid) {
  const smoothed = smoothGridValues(grid.values, grid.size, 2);
  const positive = Array.from(smoothed).filter((value) => value > 0).sort((a, b) => a - b);
  const percentileIndex = Math.max(0, Math.ceil(positive.length * 0.98) - 1);
  const scale = positive[percentileIndex] || positive.at(-1) || 1;
  const values = new Float32Array(smoothed.length);
  for (let index = 0; index < smoothed.length; index += 1) {
    // Gentle gamma lift preserves quieter routes without letting spawns dominate.
    values[index] = Math.pow(Math.min(1, smoothed[index] / scale), 0.72);
  }
  return {
    size: grid.size,
    values,
    sampleCount: grid.sampleCount,
    eventCount: grid.eventCount,
    scale,
  };
}

function mapLayerThreshold(transform) {
  const value = Number(transform?.lower_level_max_units);
  return Number.isFinite(value) ? value : null;
}

export function heatmapPointMatchesLayer(point, transform, layer) {
  const threshold = mapLayerThreshold(transform);
  if (threshold == null) return true;
  const z = Number(point?.z);
  if (!Number.isFinite(z)) return true;
  return layer === "lower" ? z <= threshold : z > threshold;
}

function depositWorldPoint(grid, point, transform, weight) {
  const radarPoint = worldToRadarPercent(point, transform);
  if (!radarPoint) return false;
  return depositHeatmapPoint(grid, radarPoint.x, radarPoint.y, weight);
}

function nearestFrame(frames, tick) {
  if (!Array.isArray(frames) || !frames.length) return null;
  let low = 0;
  let high = frames.length - 1;
  let insertion = frames.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(frames[middle]?.tick) >= tick) {
      insertion = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const previous = frames[Math.max(0, insertion - 1)];
  const next = frames[Math.min(frames.length - 1, insertion)];
  return Math.abs(Number(next?.tick) - tick) < Math.abs(Number(previous?.tick) - tick)
    ? next
    : previous;
}

function playerAtEvent(frames, tick, name) {
  const frame = nearestFrame(frames, tick);
  const key = String(name || "").trim().toLowerCase();
  return frame?.players?.find((player) => String(player?.name || "").trim().toLowerCase() === key) || null;
}

function killPoint(event, prefix, fallback) {
  const x = Number(event?.[`${prefix}_x`]);
  const y = Number(event?.[`${prefix}_y`]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
  const z = Number(event?.[`${prefix}_z`]);
  return { x, y, z: Number.isFinite(z) ? z : fallback?.z };
}

function depositCombat(grid, attacker, victim, transform) {
  const attackerPercent = worldToRadarPercent(attacker, transform);
  const victimPercent = worldToRadarPercent(victim, transform);
  if (attackerPercent) depositHeatmapPoint(grid, attackerPercent.x, attackerPercent.y, 0.7);
  if (victimPercent) depositHeatmapPoint(grid, victimPercent.x, victimPercent.y, 1.45);
  if (attackerPercent && victimPercent) {
    // A short engagement corridor makes the heat field describe the fight,
    // rather than only two isolated endpoints.
    for (const ratio of [0.25, 0.5, 0.75]) {
      depositHeatmapPoint(
        grid,
        attackerPercent.x + (victimPercent.x - attackerPercent.x) * ratio,
        attackerPercent.y + (victimPercent.y - attackerPercent.y) * ratio,
        ratio === 0.5 ? 0.5 : 0.3,
      );
    }
  }
}

function accumulateRoundLayer({ movement, combat }, bundle, transform, layer) {
  const frames = Array.isArray(bundle?.frames) ? bundle.frames : [];
  const fps = Math.max(1, Number(bundle?.fps) || 32);
  const stride = Math.max(1, Math.round(fps / MOVEMENT_SAMPLE_HZ));
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += stride) {
    for (const player of frames[frameIndex]?.players || []) {
      if (player?.is_alive === false || !heatmapPointMatchesLayer(player, transform, layer)) continue;
      depositWorldPoint(movement, player, transform, 1);
    }
  }

  for (const event of bundle?.round?.events || []) {
    if (event?.type !== "kill") continue;
    const tick = Number(event.tick || 0);
    const attackerFallback = playerAtEvent(frames, tick, event.actor);
    const victimFallback = playerAtEvent(frames, tick, event.target);
    const attacker = killPoint(event, "actor", attackerFallback);
    const victim = killPoint(event, "target", victimFallback);
    const layerAttacker = attacker && heatmapPointMatchesLayer(attacker, transform, layer)
      ? attacker
      : null;
    const layerVictim = victim && heatmapPointMatchesLayer(victim, transform, layer)
      ? victim
      : null;
    if (!layerAttacker && !layerVictim) continue;
    depositCombat(combat, layerAttacker, layerVictim, transform);
    combat.eventCount += 1;
  }
}

function createLayerAccumulators() {
  return {
    movement: createHeatmapGrid(),
    combat: createHeatmapGrid(),
  };
}

function finalizeLayer(layer) {
  return {
    movement: normalizeGrid(layer.movement),
    combat: normalizeGrid(layer.combat),
  };
}

export function buildReplayHeatmapSet({ roundBundles = [], transform, hasMapLayers = false } = {}) {
  if (!transform) return null;
  const upper = createLayerAccumulators();
  const lower = hasMapLayers ? createLayerAccumulators() : null;
  for (const bundle of roundBundles) {
    accumulateRoundLayer(upper, bundle, transform, "upper");
    if (lower) accumulateRoundLayer(lower, bundle, transform, "lower");
  }
  return {
    upper: finalizeLayer(upper),
    lower: lower ? finalizeLayer(lower) : null,
    roundCount: roundBundles.length,
  };
}
