import { describe, expect, it } from "vitest";
import { mapRecordedClipRow, reconcileRecordedClipDuration } from "./mediaUtils.js";

describe("recorded media duration reconciliation", () => {
  it("replaces a stale database duration with the browser-measured duration", () => {
    const item = mapRecordedClipRow({ id: 9, duration_sec: 16, output_path: "clip.mp4" });
    const result = reconcileRecordedClipDuration([item], 9, 8.02);
    expect(result[0].duration).toBeCloseTo(8.02);
    expect(result[0]._raw.duration_sec).toBeCloseTo(8.02);
  });

  it("keeps the same array for matching or invalid measurements", () => {
    const items = [mapRecordedClipRow({ id: 9, duration_sec: 8, output_path: "clip.mp4" })];
    expect(reconcileRecordedClipDuration(items, 9, 8.01)).toBe(items);
    expect(reconcileRecordedClipDuration(items, 9, Number.NaN)).toBe(items);
  });
});
