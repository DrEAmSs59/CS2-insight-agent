const INFERNO_CELL_SIZE_WORLD = 36;
const DEFAULT_SMOKE_CELL_SIZE_WORLD = 20;

function normalizedName(value) {
  return String(value || "").trim().toLowerCase();
}

function activeSample(track, tick, hideAfterTick) {
  const currentTick = Number(tick);
  if (!track || !Number.isFinite(currentTick) || !Array.isArray(track.samples)) return null;
  if (currentTick < Number(track.start_tick)) return null;
  if (Number.isFinite(Number(track.end_tick)) && currentTick > Number(track.end_tick)) return null;
  if (Number.isFinite(Number(hideAfterTick)) && Number(hideAfterTick) > 0 && currentTick > Number(hideAfterTick)) {
    return null;
  }
  let result = null;
  for (const sample of track.samples) {
    if (Number(sample?.tick) <= currentTick) result = sample;
    else break;
  }
  return result;
}

/**
 * Count only credited, current-round enemy kills. World/bomb deaths, unknown
 * actors, team kills, and future events cannot create observer HUD stars.
 */
export function roundEnemyKillCounts(events, tick, players, maxStars = 5) {
  const teamByName = new Map(
    (players || [])
      .map((player) => [normalizedName(player?.name || player?.player_name), String(player?.team_key || "")])
      .filter(([name, team]) => name && team),
  );
  const counts = {};
  const seen = new Set();
  for (const event of events || []) {
    if (event?.type !== "kill" || Number(event?.tick || 0) > Number(tick || 0)) continue;
    const actor = normalizedName(event.actor);
    const target = normalizedName(event.target);
    const actorTeam = teamByName.get(actor);
    const targetTeam = teamByName.get(target);
    if (!actor || actor === "world" || !target || !actorTeam || !targetTeam || actorTeam === targetTeam) continue;
    const identity = [
      Number(event.tick || 0),
      actor,
      target,
      normalizedName(event.weapon),
    ].join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);
    counts[actor] = Math.min(Math.max(0, Number(maxStars) || 5), (counts[actor] || 0) + 1);
  }
  return counts;
}

function finitePosition(player) {
  const x = Number(player?.x);
  const y = Number(player?.y);
  const z = Number(player?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function touchesSmokeCell(position, cell, cellSize) {
  if (!Array.isArray(cell) || cell.length < 3) return false;
  const half = Math.max(1, cellSize / 2);
  if (Math.abs(position.x - Number(cell[0])) > half || Math.abs(position.y - Number(cell[1])) > half) return false;
  // Sample feet, torso and head. This is deliberately cell-tight: no visual
  // effect is shown unless the player's body intersects an occupied voxel.
  return [position.z + 8, position.z + 36, position.z + 64]
    .some((bodyZ) => Math.abs(bodyZ - Number(cell[2])) <= half);
}

function touchesInfernoCell(position, cell, cellSize) {
  if (!Array.isArray(cell) || cell.length < 3) return false;
  const half = Math.max(1, cellSize / 2);
  return (
    Math.abs(position.x - Number(cell[0])) <= half
    && Math.abs(position.y - Number(cell[1])) <= half
    && Math.abs(position.z - Number(cell[2])) <= 72
  );
}

/**
 * Determine HUD smoke/fire state directly from the same sparse world cells
 * rendered on the radar. No radius estimate is used when cell data is absent.
 */
export function replayUtilityExposureByName(players, effectTracks, tick, hideAfterTick = null) {
  const activeLayers = [];
  for (const track of effectTracks || []) {
    if (track?.type !== "smoke" && track?.type !== "inferno") continue;
    const sample = activeSample(track, tick, hideAfterTick);
    if (!sample?.cells?.length) continue;
    activeLayers.push({
      type: track.type,
      cells: sample.cells,
      cellSize: Number(sample.cell_size || track.cell_size)
        || (track.type === "smoke" ? DEFAULT_SMOKE_CELL_SIZE_WORLD : INFERNO_CELL_SIZE_WORLD),
    });
  }

  const result = {};
  for (const player of players || []) {
    if (player?.is_alive === false) continue;
    const name = normalizedName(player?.name);
    const position = finitePosition(player);
    if (!name || !position) continue;
    let smoked = false;
    let burning = false;
    for (const layer of activeLayers) {
      if (layer.type === "smoke" && !smoked) {
        smoked = layer.cells.some((cell) => touchesSmokeCell(position, cell, layer.cellSize));
      } else if (layer.type === "inferno" && !burning) {
        burning = layer.cells.some((cell) => touchesInfernoCell(position, cell, layer.cellSize));
      }
      if (smoked && burning) break;
    }
    result[name] = { smoked, burning };
  }
  return result;
}
