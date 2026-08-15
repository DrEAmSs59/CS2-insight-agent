import { describe, expect, it } from "vitest";
import { liteCutRangePatchFromDraggedEdge, liteCutRangePatchFromPlayhead, normalizeLiteCutExportRange } from "./exportUtils.js";

describe("normalizeLiteCutExportRange", () => {
  it("defaults to full range", () => {
    expect(normalizeLiteCutExportRange({}, 12)).toEqual({
      rangeMode: "full",
      rangeStartSec: 0,
      rangeEndSec: 12,
      rangeValid: true,
    });
  });

  it("clamps custom ranges to the timeline duration", () => {
    expect(
      normalizeLiteCutExportRange(
        { range_mode: "custom", range_start_sec: -4, range_end_sec: 99 },
        10,
      ),
    ).toEqual({
      rangeMode: "custom",
      rangeStartSec: 0,
      rangeEndSec: 10,
      rangeValid: true,
    });
  });

  it("keeps the end after the start", () => {
    const range = normalizeLiteCutExportRange(
      { range_mode: "custom", range_start_sec: 9.95, range_end_sec: 2 },
      10,
    );
    expect(range.rangeStartSec).toBeCloseTo(9.9);
    expect(range.rangeEndSec).toBeCloseTo(10);
    expect(range.rangeValid).toBe(true);
  });
});

describe("liteCutRangePatchFromPlayhead", () => {
  it("sets the custom range start at the playhead and preserves a valid end", () => {
    expect(liteCutRangePatchFromPlayhead({ range_end_sec: 8 }, 12, 5, "start")).toEqual({
      range_mode: "custom",
      range_start_sec: 5,
      range_end_sec: 8,
    });
  });

  it("pushes the custom range end after a new start when needed", () => {
    expect(liteCutRangePatchFromPlayhead({ range_end_sec: 2 }, 12, 5, "start")).toEqual({
      range_mode: "custom",
      range_start_sec: 5,
      range_end_sec: 5.1,
    });
  });

  it("sets the custom range end at the playhead when it is after the start", () => {
    expect(liteCutRangePatchFromPlayhead({ range_start_sec: 2 }, 12, 7, "end")).toEqual({
      range_mode: "custom",
      range_start_sec: 2,
      range_end_sec: 7,
    });
  });
});

describe("liteCutRangePatchFromDraggedEdge", () => {
  it("moves only the dragged In point and preserves a minimum range", () => {
    expect(liteCutRangePatchFromDraggedEdge({ range_mode: "custom", range_start_sec: 2, range_end_sec: 8 }, 12, 9, "start")).toEqual({
      range_mode: "custom",
      range_start_sec: 7.9,
      range_end_sec: 8,
    });
  });

  it("moves only the dragged Out point and clamps it after In", () => {
    expect(liteCutRangePatchFromDraggedEdge({ range_mode: "custom", range_start_sec: 2, range_end_sec: 8 }, 12, 1, "end")).toEqual({
      range_mode: "custom",
      range_start_sec: 2,
      range_end_sec: 2.1,
    });
  });
});
