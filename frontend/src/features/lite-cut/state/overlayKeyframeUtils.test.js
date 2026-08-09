import { describe, expect, it } from "vitest";
import { keyframeNearPlayhead, overlayTransformAt } from "./overlayKeyframeUtils.js";

describe("overlay keyframe interpolation", () => {
  const overlay = {
    timeline_start: 10,
    duration: 4,
    transform: { x: 0.1, y: 0.2, scale: 1, rotation: 0, width: 0.3, opacity: 1 },
    keyframes: [
      { time_sec: 0, transform: { x: 0.1, y: 0.2, scale: 1, rotation: 0, width: 0.3, opacity: 1 } },
      { time_sec: 4, transform: { x: 0.9, y: 0.6, scale: 2, rotation: 90, width: 0.5, opacity: 0.4 } },
    ],
  };

  it("linearly interpolates transform fields at the current playhead", () => {
    expect(overlayTransformAt(overlay, 12)).toMatchObject({ x: 0.5, y: 0.4, scale: 1.5, rotation: 45, width: 0.4, opacity: 0.7 });
  });

  it("finds a keyframe from absolute playhead time", () => {
    expect(keyframeNearPlayhead(overlay, 14)?.time_sec).toBe(4);
    expect(keyframeNearPlayhead(overlay, 13)).toBeNull();
  });
});
