import { describe, expect, it } from "vitest";
import {
  normalizeWaveformBuckets,
  waveformBarCountForWidth,
  waveformFromAudioBuffer,
  waveformPeaksForSourceTimes,
} from "./audioWaveformUtils.js";

describe("audio waveform utilities", () => {
  it("normalizes buckets while retaining a visible baseline", () => {
    expect(normalizeWaveformBuckets([], 4)).toEqual([0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);
    expect(normalizeWaveformBuckets([0, 0.25, -1, 0.5], 8)).toEqual(expect.arrayContaining([1]));
  });

  it("combines channels before producing bucket peaks", () => {
    const buffer = {
      length: 4,
      numberOfChannels: 2,
      getChannelData: (channel) => (channel === 0 ? new Float32Array([0, 0.5, 0, 0]) : new Float32Array([0, 0, 1, 0])),
    };
    const values = waveformFromAudioBuffer(buffer, 8);
    expect(values).toHaveLength(8);
    expect(Math.max(...values)).toBe(1);
  });

  it("matches waveform density to visible CSS pixels without creating unbounded DOM work", () => {
    expect(waveformBarCountForWidth(24)).toBe(16);
    expect(waveformBarCountForWidth(240)).toBe(80);
    expect(waveformBarCountForWidth(960)).toBe(320);
    expect(waveformBarCountForWidth(10_000)).toBe(512);
    expect(normalizeWaveformBuckets([], 10_000)).toHaveLength(512);
  });

  it("remaps cached source peaks in either playback direction", () => {
    const peaks = [0.1, 0.2, 0.6, 1];
    const forward = waveformPeaksForSourceTimes(peaks, {
      rangeStartSec: 0,
      rangeEndSec: 4,
      sourceTimes: [0.5, 1.5, 2.5, 3.5],
    });
    const reverse = waveformPeaksForSourceTimes(peaks, {
      rangeStartSec: 0,
      rangeEndSec: 4,
      sourceTimes: [3.5, 2.5, 1.5, 0.5],
    });
    expect(reverse).toEqual([...forward].reverse());
    expect(Math.max(...forward)).toBe(1);
  });
});
