/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import semantics from "../../../../../backend/tests/fixtures/lite_cut/lite_cut_timeline_semantics.json";
import {
  clipCanvasFit,
  clipMediaTimelineDuration,
  clipPreservePitch,
  clipReversePlayback,
  clipSourceTimeForTimeline,
  clipSpeedSegments,
  clipTimelineDuration,
  clipTimelineTimeForSource,
} from "./timelineMath.js";
import {
  clipMediaTimelineDuration as legacyMediaDuration,
  clipSourceTimeForTimeline as legacySourceTimeForTimeline,
  clipSpeedSegments as legacySpeedSegments,
  clipTimelineDuration as legacyTimelineDuration,
  clipTimelineTimeForSource as legacyTimelineTimeForSource,
} from "../state/timelineUtils.js";

describe("shared LiteCut timeline semantics", () => {
  it.each(semantics.clip_time_cases)("maps source and timeline time for $name", (fixture) => {
    expect(clipSpeedSegments(fixture.clip).map((item) => [item.sourceStart, item.sourceEnd, item.speed])).toEqual(fixture.expected_segments);
    for (const [source, expected] of fixture.source_to_timeline) {
      expect(clipTimelineTimeForSource(fixture.clip, source)).toBeCloseTo(expected, 6);
    }
    for (const [timeline, expected] of fixture.timeline_to_source) {
      expect(clipSourceTimeForTimeline(fixture.clip, timeline)).toBeCloseTo(expected, 6);
    }
    expect(clipMediaTimelineDuration(fixture.clip)).toBeCloseTo(fixture.media_timeline_duration, 6);
    expect(clipTimelineDuration(fixture.clip)).toBeCloseTo(fixture.timeline_duration, 6);
    expect(clipReversePlayback(fixture.clip)).toBe(fixture.reverse);
    expect(clipPreservePitch(fixture.clip)).toBe(fixture.preserve_pitch);
    expect(clipCanvasFit(fixture.clip)).toBe(fixture.canvas_fit);
  });

  it.each(semantics.clip_time_cases)("keeps the timelineUtils facade equivalent for $name", (fixture) => {
    expect(legacySpeedSegments(fixture.clip)).toEqual(clipSpeedSegments(fixture.clip));
    for (const [source] of fixture.source_to_timeline) {
      expect(legacyTimelineTimeForSource(fixture.clip, source)).toBeCloseTo(clipTimelineTimeForSource(fixture.clip, source), 6);
    }
    for (const [timeline] of fixture.timeline_to_source) {
      expect(legacySourceTimeForTimeline(fixture.clip, timeline)).toBeCloseTo(clipSourceTimeForTimeline(fixture.clip, timeline), 6);
    }
    expect(legacyMediaDuration(fixture.clip)).toBeCloseTo(clipMediaTimelineDuration(fixture.clip), 6);
    expect(legacyTimelineDuration(fixture.clip)).toBeCloseTo(clipTimelineDuration(fixture.clip), 6);
  });
});
