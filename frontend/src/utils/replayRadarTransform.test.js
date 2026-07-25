import { describe, expect, test } from "vitest";
import {
  radarPixelToWorld,
  resolveReplayTransform,
  worldLengthToRadarPercent,
  worldToRadarPercent,
  yawToCssRotation,
} from "./replayRadarTransform";

const anubis = { pos_x: -2796, pos_y: 3328, scale: 5.22 };

describe("resolveReplayTransform", () => {
  test("prefers response over workspace", () => {
    expect(resolveReplayTransform({
      responseTransform: { scale: 5 },
      workspaceTransform: { scale: 9 },
    }).scale).toBe(5);
  });

  test("falls back to workspace then fallback", () => {
    expect(resolveReplayTransform({
      workspaceTransform: { scale: 7 },
      fallbackTransform: { scale: 1 },
    }).scale).toBe(7);
    expect(resolveReplayTransform({
      fallbackTransform: { scale: 1 },
    }).scale).toBe(1);
  });
});

describe("worldToRadarPercent", () => {
  test("maps anubis detonation-like point with standard axes", () => {
    const percent = worldToRadarPercent({ x: -2796, y: 3328 }, anubis);
    expect(percent).toEqual({ x: 0, y: 0 });
  });

  test("maps content_rect when provided", () => {
    const t = {
      pos_x: 0,
      pos_y: 0,
      scale: 1,
      content_x: 24,
      content_y: 18,
      content_width: 976,
      content_height: 982,
    };
    const percent = worldToRadarPercent({ x: 24, y: -18 }, t);
    // mapX=24, mapY=18 → (24-24)/976, (18-18)/982
    expect(percent.x).toBeCloseTo(0, 5);
    expect(percent.y).toBeCloseTo(0, 5);
  });
});

describe("round-trip and length", () => {
  test("radarPixelToWorld inverts worldToRadarPercent at 1024 viewport", () => {
    const world = { x: -1000, y: 2000 };
    const pct = worldToRadarPercent(world, anubis);
    const px = { x: (pct.x / 100) * 1024, y: (pct.y / 100) * 1024 };
    const back = radarPixelToWorld(px, anubis, { width: 1024, height: 1024 });
    expect(back.x).toBeCloseTo(world.x, 4);
    expect(back.y).toBeCloseTo(world.y, 4);
  });

  test("worldLengthToRadarPercent uses scale", () => {
    expect(worldLengthToRadarPercent(5.22, anubis)).toBeCloseTo(100 / 1024, 6);
  });
});

describe("yawToCssRotation", () => {
  test("yaw 90 (north) points screen-up on standard maps", () => {
    expect(yawToCssRotation(90)).toBe(0);
  });

  test("yaw 0 (east) points screen-right on standard maps", () => {
    expect(yawToCssRotation(0)).toBe(90);
  });
});
