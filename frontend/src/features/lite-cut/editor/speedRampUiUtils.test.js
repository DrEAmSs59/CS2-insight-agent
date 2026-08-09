import { describe, expect, it } from "vitest";
import { matchingSpeedRampPresetId, speedRampDisplaySegments, speedRampPointsForPreset, timelineSpeedRampSegments } from "./speedRampUiUtils.js";

describe("speed ramp UI", () => {
  it("builds preset points inside the visible trimmed source range", () => {
    expect(speedRampPointsForPreset("slow-fast", 4, 10)).toEqual([
      { source_sec: 4, speed: 0.5 },
      { source_sec: 9.5, speed: 2 },
      { source_sec: 14, speed: 2 },
    ]);
  });

  it("identifies untouched presets and labels edited ramps as custom", () => {
    const points = speedRampPointsForPreset("impact", 0, 10);
    expect(matchingSpeedRampPresetId(points, 0, 10)).toBe("impact");
    points[1] = { ...points[1], speed: 0.5 };
    expect(matchingSpeedRampPresetId(points, 0, 10)).toBeNull();
  });

  it("describes source-relative segment widths and speeds", () => {
    const segments = speedRampDisplaySegments(speedRampPointsForPreset("fast-slow", 0, 10), 0, 10);
    expect(segments).toMatchObject([
      { from: 0, to: 45, width: 45, speed: 2 },
      { from: 45, to: 100, width: 55, speed: 0.5 },
    ]);
  });

  it("lays timeline labels out by the visible duration after speed changes", () => {
    const segments = timelineSpeedRampSegments({
      trim_in: 0,
      trim_out: 10,
      speed_keyframes: [
        { source_sec: 0, speed: 0.5 },
        { source_sec: 5, speed: 2 },
        { source_sec: 10, speed: 2 },
      ],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ left: 0, width: 80, speed: 0.5, sourceFrom: 0, sourceTo: 50 });
    expect(segments[1]).toMatchObject({ left: 80, width: 20, speed: 2, sourceFrom: 50, sourceTo: 100 });
  });
});
