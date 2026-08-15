import { describe, expect, it } from "vitest";
import { streamUrlForTimelineClip, timelineClipClass, timelineClipTone } from "./TimelineClip.jsx";

describe("TimelineClip helpers", () => {
  it("keeps MOV clips on video tracks visually classified as video", () => {
    expect(timelineClipTone("video", { meta: { kind: "image", name: "alpha.mov" } })).toBe("video");
  });

  it("resolves both imported and Insight-recorded media waveform routes", () => {
    expect(streamUrlForTimelineClip({ source_type: "file", meta: { asset_id: 7 } })).toContain("/api/lite-cut/assets/7/stream");
    expect(streamUrlForTimelineClip({ source_id: "clip-42" })).toContain("/api/recorded-clips/clip-42/stream");
  });

  it("uses the theme-owned solid clip style without legacy shadows", () => {
    const className = timelineClipClass("video", true, false, false);
    expect(className).toContain("litecut-timeline-clip--video");
    expect(className).toContain("ring-1");
    expect(className).not.toContain("shadow");
  });
});
