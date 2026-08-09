import { describe, expect, test } from "vitest";
import {
  cameraCssTransform,
  clampUserZoom,
  computeFitScale,
  panBy,
  rescaleCameraForFitChange,
  restoreCameraForViewport,
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

  test("restoreCameraForViewport scales offsets by fitScale ratio", () => {
    const saved = { fitScale: 0.5, userZoom: 2, offsetX: 100, offsetY: -40 };
    const fitted = { fitScale: 1, userZoom: 1, offsetX: 0, offsetY: 0 };
    const viewport = { width: 800, height: 800 };
    const restored = restoreCameraForViewport(saved, fitted, viewport);
    expect(restored.fitScale).toBe(1);
    expect(restored.userZoom).toBe(2);
    expect(restored.offsetX).toBeCloseTo(200, 5);
    expect(restored.offsetY).toBeCloseTo(-80, 5);
  });

  test("rescaleCameraForFitChange scales then clamps so scene stays overlapping", () => {
    const camera = { fitScale: 1, userZoom: 3, offsetX: -8000, offsetY: -8000 };
    const viewport = { width: 400, height: 400 };
    const next = rescaleCameraForFitChange(camera, 2, viewport);
    expect(next.fitScale).toBe(2);
    // Raw scaled offsets would be -16000; clamp must pull them back into overlap.
    expect(next.offsetX).toBeGreaterThan(-16000);
    expect(next.offsetY).toBeGreaterThan(-16000);
    const scale = next.fitScale * next.userZoom;
    expect(next.offsetX).toBeLessThan(400);
    expect(next.offsetY).toBeLessThan(400);
    expect(next.offsetX + 1024 * scale).toBeGreaterThan(0);
    expect(next.offsetY + 1024 * scale).toBeGreaterThan(0);
  });
});
