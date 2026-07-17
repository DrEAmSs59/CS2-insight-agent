import { describe, expect, it } from "vitest";
import { normalizeWaveformBuckets, waveformFromAudioBuffer } from "./audioWaveformUtils.js";

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
});
