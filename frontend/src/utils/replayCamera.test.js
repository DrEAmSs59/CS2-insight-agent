import { describe, expect, test } from "vitest";
import {
  cameraCssTransform,
  clampUserZoom,
  computeFitScale,
  panBy,
  zoomAtPointer,
} from "./replayCamera";

describe("replayCamera", () => {
  test("zoomAtPointer keeps scene point under cursor", () => {
    const before = { offsetX: 10, offsetY: 20, scale: 1 };
    const pointer = { pointerX: 110, pointerY: 220 };
    const sceneX = (pointer.pointerX - before.offsetX) / before.scale;
    const sceneY = (pointer.pointerY - before.offsetY) / before.scale;
    const after = zoomAtPointer({ ...before, ...pointer, nextScale: 2 });
    expect(after.offsetX + sceneX * after.scale).toBeCloseTo(pointer.pointerX, 5);
    expect(after.offsetY + sceneY * after.scale).toBeCloseTo(pointer.pointerY, 5);
  });

  test("computeFitScale uses content rect", () => {
    const s = computeFitScale(
      { width: 880, height: 880 },
      { width: 900, height: 790 },
      { coverRatio: 0.88 },
    );
    expect(s).toBeCloseTo(Math.min(880 / 900, 880 / 790) * 0.88, 5);
  });

  test("clampUserZoom clamps to 0.6..3", () => {
    expect(clampUserZoom(0.1)).toBe(0.6);
    expect(clampUserZoom(1)).toBe(1);
    expect(clampUserZoom(9)).toBe(3);
  });

  test("cameraCssTransform emits translate then scale", () => {
    expect(cameraCssTransform({ offsetX: 12.5, offsetY: -4, scale: 0.75 }))
      .toBe("translate(12.5px, -4px) scale(0.75)");
  });

  test("panBy clamps so scene cannot leave the viewport entirely", () => {
    const camera = { fitScale: 1, userZoom: 2, offsetX: 0, offsetY: 0 };
    const next = panBy(camera, 5000, 5000, { width: 400, height: 400 }, { width: 1024, height: 1024 });
    expect(next.offsetX).toBeLessThan(400);
    expect(next.offsetY).toBeLessThan(400);
    expect(next.offsetX + 1024 * 2).toBeGreaterThan(0);
    expect(next.offsetY + 1024 * 2).toBeGreaterThan(0);
  });
});
