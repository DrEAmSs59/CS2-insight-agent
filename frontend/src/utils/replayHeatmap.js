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

export function replayHeatmapPlayerKey(value) {
  return String(value || "").trim().toLowerCase();
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
  const key = replayHeatmapPlayerKey(name);
  return frame?.players?.find((player) => replayHeatmapPlayerKey(player?.name) === key) || null;
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

function createLayerAccumulators() {
  return {
    movement: createHeatmapGrid(),
    combat: createHeatmapGrid(),
    kills: createHeatmapGrid(),
    deaths: createHeatmapGrid(),
  };
}

function createSpatialAccumulators(hasMapLayers) {
  return {
    upper: createLayerAccumulators(),
    lower: hasMapLayers ? createLayerAccumulators() : null,
  };
}

function createPlayerAccumulator(name, hasMapLayers) {
  return {
    name,
    ...createSpatialAccumulators(hasMapLayers),
    sides: {
      CT: createSpatialAccumulators(hasMapLayers),
      T: createSpatialAccumulators(hasMapLayers),
    },
  };
}

function playerAccumulator(playerAccumulators, name, hasMapLayers) {
  const key = replayHeatmapPlayerKey(name);
  if (!key) return null;
  if (!playerAccumulators.has(key)) {
    playerAccumulators.set(key, createPlayerAccumulator(String(name || "").trim(), hasMapLayers));
  }
  return playerAccumulators.get(key);
}

function incrementEvent(grid) {
  if (grid) grid.eventCount += 1;
}

function accumulateCombatForLayer(accumulators, attacker, victim, transform) {
  if (!accumulators || (!attacker && !victim)) return;
  depositCombat(accumulators.combat, attacker, victim, transform);
  incrementEvent(accumulators.combat);
}

function normalizeSide(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "2" || raw === "T" || raw === "TERRORIST") return "T";
  if (raw === "3" || raw === "CT" || raw === "COUNTERTERRORIST") return "CT";
  return "";
}

function normalizePlayerTeamKeys(playerTeamKeys) {
  const entries = playerTeamKeys instanceof Map
    ? Array.from(playerTeamKeys.entries())
    : Object.entries(playerTeamKeys || {});
  return new Map(entries.map(([name, teamKey]) => [replayHeatmapPlayerKey(name), teamKey]));
}

function playerSide(player, name, bundle, playerTeamKeys) {
  const frameSide = normalizeSide(player?.team ?? player?.team_number);
  if (frameSide) return frameSide;
  const teamKey = playerTeamKeys.get(replayHeatmapPlayerKey(name));
  const roundSide = teamKey === "a"
    ? bundle?.round?.team_a_side
    : teamKey === "b"
      ? bundle?.round?.team_b_side
      : "";
  return normalizeSide(roundSide);
}

function accumulateRound(
  { aggregate, playerAccumulators },
  bundle,
  transform,
  hasMapLayers,
  playerTeamKeys,
) {
  const frames = Array.isArray(bundle?.frames) ? bundle.frames : [];
  const fps = Math.max(1, Number(bundle?.fps) || 32);
  const stride = Math.max(1, Math.round(fps / MOVEMENT_SAMPLE_HZ));
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += stride) {
    for (const player of frames[frameIndex]?.players || []) {
      if (player?.is_alive === false) continue;
      const individual = playerAccumulator(playerAccumulators, player?.name, hasMapLayers);
      const side = playerSide(player, player?.name, bundle, playerTeamKeys);
      for (const layer of hasMapLayers ? ["upper", "lower"] : ["upper"]) {
        if (!heatmapPointMatchesLayer(player, transform, layer)) continue;
        depositWorldPoint(aggregate[layer].movement, player, transform, 1);
        if (individual) depositWorldPoint(individual[layer].movement, player, transform, 1);
        if (individual && side) depositWorldPoint(individual.sides[side][layer].movement, player, transform, 1);
      }
    }
  }

  for (const event of bundle?.round?.events || []) {
    if (event?.type !== "kill") continue;
    const tick = Number(event.tick || 0);
    const attackerFallback = playerAtEvent(frames, tick, event.actor);
    const victimFallback = playerAtEvent(frames, tick, event.target);
    const attacker = killPoint(event, "actor", attackerFallback);
    const victim = killPoint(event, "target", victimFallback);
    const attackerName = String(event.actor || attackerFallback?.name || "").trim();
    const victimName = String(event.target || victimFallback?.name || "").trim();
    const attackerAccumulator = playerAccumulator(playerAccumulators, attackerName, hasMapLayers);
    const victimAccumulator = playerAccumulator(playerAccumulators, victimName, hasMapLayers);
    const attackerSide = playerSide(attackerFallback, attackerName, bundle, playerTeamKeys);
    const victimSide = playerSide(victimFallback, victimName, bundle, playerTeamKeys);
    const attackerSideAccumulator = attackerSide ? attackerAccumulator?.sides?.[attackerSide] : null;
    const victimSideAccumulator = victimSide ? victimAccumulator?.sides?.[victimSide] : null;

    for (const layer of hasMapLayers ? ["upper", "lower"] : ["upper"]) {
      const layerAttacker = attacker && heatmapPointMatchesLayer(attacker, transform, layer)
        ? attacker
        : null;
      const layerVictim = victim && heatmapPointMatchesLayer(victim, transform, layer)
        ? victim
        : null;
      if (!layerAttacker && !layerVictim) continue;

      accumulateCombatForLayer(aggregate[layer], layerAttacker, layerVictim, transform);
      accumulateCombatForLayer(attackerAccumulator?.[layer], layerAttacker, layerVictim, transform);
      accumulateCombatForLayer(attackerSideAccumulator?.[layer], layerAttacker, layerVictim, transform);
      if (victimAccumulator && victimAccumulator !== attackerAccumulator) {
        accumulateCombatForLayer(victimAccumulator[layer], layerAttacker, layerVictim, transform);
      }
      if (victimSideAccumulator && victimSideAccumulator !== attackerSideAccumulator) {
        accumulateCombatForLayer(victimSideAccumulator[layer], layerAttacker, layerVictim, transform);
      }

      if (layerAttacker && depositWorldPoint(aggregate[layer].kills, layerAttacker, transform, 1)) {
        incrementEvent(aggregate[layer].kills);
      }
      if (layerAttacker && attackerAccumulator
        && depositWorldPoint(attackerAccumulator[layer].kills, layerAttacker, transform, 1)) {
        incrementEvent(attackerAccumulator[layer].kills);
      }
      if (layerAttacker && attackerSideAccumulator
        && depositWorldPoint(attackerSideAccumulator[layer].kills, layerAttacker, transform, 1)) {
        incrementEvent(attackerSideAccumulator[layer].kills);
      }
      if (layerVictim && depositWorldPoint(aggregate[layer].deaths, layerVictim, transform, 1)) {
        incrementEvent(aggregate[layer].deaths);
      }
      if (layerVictim && victimAccumulator
        && depositWorldPoint(victimAccumulator[layer].deaths, layerVictim, transform, 1)) {
        incrementEvent(victimAccumulator[layer].deaths);
      }
      if (layerVictim && victimSideAccumulator
        && depositWorldPoint(victimSideAccumulator[layer].deaths, layerVictim, transform, 1)) {
        incrementEvent(victimSideAccumulator[layer].deaths);
      }
    }
  }
}

function finalizeLayer(layer) {
  return {
    movement: normalizeGrid(layer.movement),
    combat: normalizeGrid(layer.combat),
    kills: normalizeGrid(layer.kills),
    deaths: normalizeGrid(layer.deaths),
  };
}

export function buildReplayHeatmapSet({
  roundBundles = [],
  transform,
  hasMapLayers = false,
  playerTeamKeys = {},
} = {}) {
  if (!transform) return null;
  const aggregate = createSpatialAccumulators(hasMapLayers);
  const playerAccumulators = new Map();
  const normalizedPlayerTeamKeys = normalizePlayerTeamKeys(playerTeamKeys);
  for (const bundle of roundBundles) {
    accumulateRound(
      { aggregate, playerAccumulators },
      bundle,
      transform,
      hasMapLayers,
      normalizedPlayerTeamKeys,
    );
  }
  const players = Object.fromEntries(Array.from(playerAccumulators, ([key, value]) => [key, {
    name: value.name,
    upper: finalizeLayer(value.upper),
    lower: value.lower ? finalizeLayer(value.lower) : null,
    sides: Object.fromEntries(["CT", "T"].map((side) => [side, {
      upper: finalizeLayer(value.sides[side].upper),
      lower: value.sides[side].lower ? finalizeLayer(value.sides[side].lower) : null,
    }])),
  }]));
  return {
    upper: finalizeLayer(aggregate.upper),
    lower: aggregate.lower ? finalizeLayer(aggregate.lower) : null,
    players,
    roundCount: roundBundles.length,
  };
}
