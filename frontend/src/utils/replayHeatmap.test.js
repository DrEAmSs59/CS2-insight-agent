import { describe, expect, it } from "vitest";
import {
  buildReplayHeatmapSet,
  createHeatmapGrid,
  depositHeatmapPoint,
} from "./replayHeatmap";

function sum(values) {
  return Array.from(values).reduce((total, value) => total + value, 0);
}

describe("replayHeatmap", () => {
  it("deposits a sample bilinearly without losing its weight", () => {
    const grid = createHeatmapGrid(4);
    expect(depositHeatmapPoint(grid, 50, 50, 2)).toBe(true);
    expect(sum(grid.values)).toBeCloseTo(2, 6);
    expect(Array.from(grid.values).filter((value) => value > 0)).toHaveLength(4);
  });

  it("builds separate movement and combat fields for map floors", () => {
    const transform = {
      pos_x: 0,
      pos_y: 100,
      scale: 0.1,
      lower_level_max_units: 0,
    };
    const upperPlayer = { name: "upper", x: 40, y: 40, z: 10, is_alive: true };
    const lowerPlayer = { name: "lower", x: 60, y: 60, z: -10, is_alive: true };
    const result = buildReplayHeatmapSet({
      transform,
      hasMapLayers: true,
      roundBundles: [{
        fps: 4,
        frames: [
          { tick: 100, players: [upperPlayer, lowerPlayer] },
          { tick: 104, players: [upperPlayer, lowerPlayer] },
        ],
        round: {
          events: [{
            type: "kill",
            tick: 104,
            actor: "upper",
            target: "lower",
            actor_x: 40,
            actor_y: 40,
            actor_z: 10,
            target_x: 60,
            target_y: 60,
            target_z: -10,
          }],
        },
      }],
    });

    expect(result.roundCount).toBe(1);
    expect(result.upper.movement.sampleCount).toBe(2);
    expect(result.lower.movement.sampleCount).toBe(2);
    // A cross-floor kill contributes its endpoint to each corresponding floor.
    expect(result.upper.combat.sampleCount).toBe(1);
    expect(result.lower.combat.sampleCount).toBe(1);
    expect(result.upper.combat.eventCount).toBe(1);
    expect(result.lower.combat.eventCount).toBe(1);
  });

  it("reconstructs kill endpoints from the nearest replay frame", () => {
    const result = buildReplayHeatmapSet({
      transform: { pos_x: 0, pos_y: 1024, scale: 1 },
      roundBundles: [{
        fps: 4,
        frames: [{
          tick: 200,
          players: [
            { name: "A", x: 200, y: 800, z: 0, is_alive: true },
            { name: "B", x: 400, y: 600, z: 0, is_alive: true },
          ],
        }],
        round: { events: [{ type: "kill", tick: 200, actor: "A", target: "B" }] },
      }],
    });

    expect(result.upper.combat.sampleCount).toBe(5);
    expect(Math.max(...result.upper.combat.values)).toBeGreaterThan(0);
  });
});
