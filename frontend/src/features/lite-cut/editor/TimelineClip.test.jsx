import { describe, expect, it } from "vitest";
import { streamUrlForTimelineClip, timelineClipTone, waveformBarsForClipWidth } from "./TimelineClip.jsx";

describe("TimelineClip helpers", () => {
  it("keeps MOV clips on video tracks visually classified as video", () => {
    expect(timelineClipTone("video", { meta: { kind: "image", name: "alpha.mov" } })).toBe("video");
  });

  it("increases cached waveform density in stable steps as the timeline zooms", () => {
    expect(waveformBarsForClipWidth(24)).toBe(16);
    expect(waveformBarsForClipWidth(240)).toBe(80);
    expect(waveformBarsForClipWidth(960)).toBe(320);
    expect(waveformBarsForClipWidth(10000)).toBe(512);
  });

  it("resolves both imported and Insight-recorded media waveform routes", () => {
    expect(streamUrlForTimelineClip({ source_type: "file", meta: { asset_id: 7 } })).toContain("/api/lite-cut/assets/7/stream");
    expect(streamUrlForTimelineClip({ source_id: "clip-42" })).toContain("/api/recorded-clips/clip-42/stream");
  });
});
