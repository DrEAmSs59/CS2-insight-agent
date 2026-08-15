import { describe, expect, it } from "vitest";
import {
  clampTimelineZoom,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  timelinePixelsPerSecond,
  timelineZoomFromSliderPercent,
  timelineZoomToSliderPercent,
} from "./timelineZoomUtils.js";

describe("timeline zoom", () => {
  it("allows the timeline to zoom from 4 to 800 percent", () => {
    expect(clampTimelineZoom(0)).toBe(TIMELINE_ZOOM_MIN);
    expect(clampTimelineZoom(0.01)).toBe(TIMELINE_ZOOM_MIN);
    expect(TIMELINE_ZOOM_MIN).toBe(0.04);
    expect(TIMELINE_ZOOM_MAX).toBe(8);
    expect(clampTimelineZoom(99)).toBe(TIMELINE_ZOOM_MAX);
  });

  it("renders thirty seconds at about 53 pixels at minimum zoom", () => {
    expect(timelinePixelsPerSecond(TIMELINE_ZOOM_MIN) * 30).toBeCloseTo(52.8);
  });

  it("maps the slider logarithmically for useful precision at low zoom", () => {
    expect(timelineZoomFromSliderPercent(0)).toBeCloseTo(TIMELINE_ZOOM_MIN);
    expect(timelineZoomFromSliderPercent(100)).toBeCloseTo(TIMELINE_ZOOM_MAX);
    for (const zoom of [0.04, 0.08, 0.12, 0.25, 0.5, 1, 2, 4, 8]) {
      expect(timelineZoomFromSliderPercent(timelineZoomToSliderPercent(zoom))).toBeCloseTo(zoom);
    }
  });
});
