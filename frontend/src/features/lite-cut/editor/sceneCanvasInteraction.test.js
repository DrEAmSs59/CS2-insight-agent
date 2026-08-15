import { describe, expect, it } from "vitest";
import {
  clampSceneScale,
  clampSceneSize,
  scenePositionForCanvasDrag,
  snapCanvasRotation,
} from "./sceneCanvasInteraction.js";

describe("scene canvas interaction", () => {
  it("moves every scene node in normalized canvas coordinates", () => {
    expect(scenePositionForCanvasDrag({
      x: 0.5,
      y: 0.5,
      deltaX: 192,
      deltaY: -108,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })).toEqual({ x: 0.6, y: 0.4, guides: { x: null, y: null } });
  });

  it("uses the scene contract instead of clipping a node center to the canvas", () => {
    expect(scenePositionForCanvasDrag({
      x: 0.9,
      y: 0.5,
      deltaX: 384,
      deltaY: 0,
      canvasWidth: 1920,
      canvasHeight: 1080,
    }).x).toBeCloseTo(1.1, 6);
  });

  it("uses the canonical scene limits for scale and box size", () => {
    expect(clampSceneScale(200)).toBe(20);
    expect(clampSceneSize(200)).toBe(20);
  });

  it("keeps editor rotation in the agreed -180 to 180 range", () => {
    expect(snapCanvasRotation(181)).toBe(180);
    expect(snapCanvasRotation(88)).toBe(90);
  });
});
