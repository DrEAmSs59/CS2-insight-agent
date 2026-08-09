import { describe, expect, it } from "vitest";
import {
  clampTimelineZoom,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  timelineZoomFromSliderPercent,
  timelineZoomToSliderPercent,
} from "./timelineZoomUtils.js";

describe("timeline zoom", () => {
  it("allows a two-minute timeline to zoom far below the old 50% minimum", () => {
    expect(clampTimelineZoom(0)).toBe(TIMELINE_ZOOM_MIN);
    expect(clampTimelineZoom(0.01)).toBe(TIMELINE_ZOOM_MIN);
    expect(TIMELINE_ZOOM_MIN).toBe(0.08);
    expect(clampTimelineZoom(99)).toBe(TIMELINE_ZOOM_MAX);
  });

  it("maps the slider logarithmically for useful precision at low zoom", () => {
    expect(timelineZoomFromSliderPercent(0)).toBeCloseTo(TIMELINE_ZOOM_MIN);
    expect(timelineZoomFromSliderPercent(100)).toBeCloseTo(TIMELINE_ZOOM_MAX);
    for (const zoom of [0.08, 0.12, 0.25, 0.5, 1, 2, 4]) {
      expect(timelineZoomFromSliderPercent(timelineZoomToSliderPercent(zoom))).toBeCloseTo(zoom);
    }
  });
});
