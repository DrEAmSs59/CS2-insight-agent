/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { waveformUrlForMediaStream } from "./AudioWaveformBars.jsx";

describe("waveformUrlForMediaStream", () => {
  it("uses the cached backend waveform endpoint for LiteCut assets", () => {
    expect(waveformUrlForMediaStream("/api/lite-cut/assets/7/stream?preview=ready", {
      bars: 120,
      startSec: 3,
      endSec: 13,
    })).toBe("/api/lite-cut/assets/7/waveform?buckets=120&start_sec=3&end_sec=13");
  });

  it("supports Insight recorded clips without downloading the full video", () => {
    expect(waveformUrlForMediaStream("http://127.0.0.1:19871/api/recorded-clips/9/stream", { bars: 48 }))
      .toBe("http://127.0.0.1:19871/api/recorded-clips/9/waveform?buckets=48&start_sec=0");
  });
});
