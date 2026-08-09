import { describe, expect, it } from "vitest";
import {
  buildTimelineRulerTicks,
  fitTimelineZoom,
  formatRulerTime,
  normalizeTimelineZoom,
  selectedTimelineItemsInMarquee,
  snapPlayheadToBoundaries,
  timelineRangePercentStyle,
  timelineClipIntersectsRange,
  timelineScrollLeftForFocus,
  timelineScrollLeftForTimeRange,
  visibleTimelineRange,
} from "./timelineInteraction.js";

describe("timeline ruler", () => {
  it("limits expensive clip rendering to the visible viewport plus overscan", () => {
    const range = visibleTimelineRange({
      scrollLeft: 1128,
      viewportWidth: 1000,
      pixelsPerSecond: 100,
      headerWidth: 128,
      overscanPx: 500,
    });
    expect(range).toEqual({ start: 5, end: 25 });
    expect(timelineClipIntersectsRange(4, 2, range)).toBe(true);
    expect(timelineClipIntersectsRange(24, 2, range)).toBe(true);
    expect(timelineClipIntersectsRange(30, 2, range)).toBe(false);
  });

  it("culls a 10,000-clip timeline to a small visible working set", () => {
    const range = { start: 5000, end: 5030 };
    const clips = Array.from({ length: 10_000 }, (_, index) => ({ start: index, duration: 0.8 }));
    const visible = clips.filter((clip) => timelineClipIntersectsRange(clip.start, clip.duration, range));
    expect(visible.length).toBeLessThanOrEqual(32);
    expect(visible[0].start).toBe(5000);
    expect(visible.at(-1).start).toBe(5030);
  });

  it("formats mm:ss labels", () => {
    expect(formatRulerTime(65)).toBe("01:05");
    expect(formatRulerTime(3)).toBe("00:03");
  });

  it("snaps the playhead to clip starts, ends, and shared seams", () => {
    expect(snapPlayheadToBoundaries(4.12, [0, 2, 4, 7], 60)).toEqual({ time: 4, snapped: true, point: 4 });
    expect(snapPlayheadToBoundaries(3.7, [0, 2, 4, 7], 60)).toEqual({ time: 3.7, snapped: false, point: null });
    expect(snapPlayheadToBoundaries(7.08, [0, 2, 4, 7], 100)).toEqual({ time: 7, snapped: true, point: 7 });
  });

  it("uses opencut-style 4 minor ticks per second at high zoom", () => {
    const ticks = buildTimelineRulerTicks(5, 5 * 80);
    const between2and3 = ticks.filter((x) => x.t > 2 && x.t < 3);
    expect(between2and3).toHaveLength(4);
    expect(between2and3.every((x) => x.kind === "minor")).toBe(true);
    expect(between2and3.map((x) => x.t)).toEqual([2.2, 2.4, 2.6, 2.8]);
  });

  it("labels every second when zoomed in", () => {
    const ticks = buildTimelineRulerTicks(4, 4 * 80);
    const majors = ticks.filter((x) => x.kind === "major");
    expect(majors.map((x) => x.label)).toEqual(["00:00", "00:01", "00:02", "00:03", "00:04"]);
  });

  it("normalizes and fits timeline zoom", () => {
    expect(normalizeTimelineZoom(0.1)).toBe(0.5);
    expect(normalizeTimelineZoom(10)).toBe(4);
    expect(fitTimelineZoom(120, 840)).toBeCloseTo(0.5);
    expect(fitTimelineZoom(30, 1200)).toBeCloseTo(1200 / (30 * 14));
  });

  it("keeps the focused time near the same viewport x after zooming", () => {
    const next = timelineScrollLeftForFocus({
      anchorClientX: 500,
      viewportLeft: 100,
      viewportWidth: 800,
      oldScrollLeft: 300,
      oldContentWidth: 1600,
      newContentWidth: 2400,
    });

    expect(next).toBeGreaterThan(300);
    expect(next).toBeLessThanOrEqual(1600);
  });

  it("centers a short timeline time range in the viewport", () => {
    const next = timelineScrollLeftForTimeRange({
      startSec: 50,
      endSec: 55,
      totalSec: 100,
      contentWidth: 2000,
      viewportWidth: 500,
    });

    expect(next).toBeGreaterThan(700);
    expect(next).toBeLessThan(900);
  });

  it("aligns the start of a wide focused timeline range with padding", () => {
    const next = timelineScrollLeftForTimeRange({
      startSec: 40,
      endSec: 90,
      totalSec: 100,
      contentWidth: 2000,
      viewportWidth: 500,
      paddingPx: 40,
    });

    expect(next).toBeCloseTo(802.4);
  });

  it("computes percent style for a visible timeline range", () => {
    expect(timelineRangePercentStyle(2, 6, 10)).toEqual({ left: "20%", width: "40%" });
    expect(timelineRangePercentStyle(8, 8, 10)).toBeNull();
    expect(timelineRangePercentStyle(1, 3, 0)).toBeNull();
  });

  it("selects clips intersecting a marquee time and row range", () => {
    const rows = [
      {
        id: "ov",
        selectionTrackId: "overlay",
        top: 0,
        bottom: 28,
        clips: [{ id: "title", start: 2, width: 3 }],
      },
      {
        id: "v1",
        top: 30,
        bottom: 74,
        clips: [
          { id: "a", start: 0, width: 2 },
          { id: "b", start: 5, width: 2 },
        ],
      },
      {
        id: "a1",
        top: 76,
        bottom: 100,
        clips: [{ id: "music", start: 4, width: 4 }],
      },
    ];

    expect(selectedTimelineItemsInMarquee(rows, 1, 6, 10, 80)).toEqual([
      { id: "a", trackId: "v1", start: 0, end: 2 },
      { id: "title", trackId: "overlay", start: 2, end: 5 },
      { id: "music", trackId: "a1", start: 4, end: 8 },
      { id: "b", trackId: "v1", start: 5, end: 7 },
    ]);
  });

  it("ignores rows outside a marquee y range", () => {
    const rows = [
      { id: "v1", top: 0, bottom: 44, clips: [{ id: "a", start: 0, width: 4 }] },
      { id: "v2", top: 46, bottom: 90, clips: [{ id: "b", start: 0, width: 4 }] },
    ];

    expect(selectedTimelineItemsInMarquee(rows, 0, 5, 50, 80)).toEqual([
      { id: "b", trackId: "v2", start: 0, end: 4 },
    ]);
  });
});
