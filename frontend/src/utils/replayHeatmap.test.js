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
    expect(result.upper.kills.eventCount).toBe(1);
    expect(result.upper.deaths.eventCount).toBe(0);
    expect(result.lower.kills.eventCount).toBe(0);
    expect(result.lower.deaths.eventCount).toBe(1);
    expect(result.players.upper.upper.movement.sampleCount).toBe(2);
    expect(result.players.upper.upper.kills.eventCount).toBe(1);
    expect(result.players.lower.lower.movement.sampleCount).toBe(2);
    expect(result.players.lower.lower.deaths.eventCount).toBe(1);
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
    expect(result.players.a.upper.combat.eventCount).toBe(1);
    expect(result.players.a.upper.kills.eventCount).toBe(1);
    expect(result.players.a.upper.deaths.eventCount).toBe(0);
    expect(result.players.b.upper.combat.eventCount).toBe(1);
    expect(result.players.b.upper.kills.eventCount).toBe(0);
    expect(result.players.b.upper.deaths.eventCount).toBe(1);
  });

  it("splits every player heatmap by CT and T side", () => {
    const frame = (tick, team, x, includeFrameSide = true) => ({
      tick,
      players: [
        { name: "A", team: includeFrameSide ? team : undefined, x, y: 800, z: 0, is_alive: true },
        { name: "B", team: includeFrameSide ? (team === "CT" ? "T" : "CT") : undefined, x: x + 100, y: 700, z: 0, is_alive: true },
      ],
    });
    const kill = (tick, actorX, targetX) => ({
      type: "kill",
      tick,
      actor: "A",
      target: "B",
      actor_x: actorX,
      actor_y: 800,
      target_x: targetX,
      target_y: 700,
    });
    const result = buildReplayHeatmapSet({
      transform: { pos_x: 0, pos_y: 1024, scale: 1 },
      playerTeamKeys: { a: "a", b: "b" },
      roundBundles: [
        {
          fps: 4,
          frames: [frame(100, "CT", 200)],
          round: {
            round_number: 1,
            team_a_side: "CT",
            team_b_side: "T",
            events: [kill(100, 200, 300)],
          },
        },
        {
          fps: 4,
          frames: [frame(200, "T", 400, false)],
          round: {
            round_number: 2,
            team_a_side: "T",
            team_b_side: "CT",
            events: [kill(200, 400, 500)],
          },
        },
      ],
    });

    expect(result.players.a.upper.movement.sampleCount).toBe(2);
    expect(result.players.a.sides.CT.upper.movement.sampleCount).toBe(1);
    expect(result.players.a.sides.T.upper.movement.sampleCount).toBe(1);
    expect(result.players.a.sides.CT.upper.kills.eventCount).toBe(1);
    expect(result.players.a.sides.T.upper.kills.eventCount).toBe(1);
    expect(result.players.b.sides.T.upper.deaths.eventCount).toBe(1);
    expect(result.players.b.sides.CT.upper.deaths.eventCount).toBe(1);
  });
});
