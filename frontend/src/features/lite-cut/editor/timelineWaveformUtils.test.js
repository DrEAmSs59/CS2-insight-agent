import { describe, expect, it } from "vitest";

import { timelineWaveformTiles } from "./timelineWaveformUtils.js";

function clip(overrides = {}) {
  return {
    trim_in: 0,
    trim_out: 1_383.416667,
    speed: 1,
    speed_keyframes: [],
    reverse: false,
    ...overrides,
  };
}

describe("timelineWaveformTiles", () => {
  it("renders only stable visible tiles for a 23 minute source", () => {
    const input = {
      clip: clip(),
      clipStart: 0,
      clipDuration: 1_383.416667,
      pixelsPerSecond: 44,
      visibleRange: { start: 100, end: 130 },
    };
    const tiles = timelineWaveformTiles(input);
    const shifted = timelineWaveformTiles({ ...input, visibleRange: { start: 101, end: 129 } });

    expect(tiles).toHaveLength(3);
    expect(tiles.map((tile) => tile.key)).toEqual(shifted.map((tile) => tile.key));
    expect(tiles.every((tile) => tile.widthPx <= 768)).toBe(true);
    expect(tiles.every((tile) => tile.bars <= 512)).toBe(true);
    expect(tiles.reduce((sum, tile) => sum + tile.bars, 0)).toBeLessThan(1_000);
  });

  it("uses a bounded initial window before the scroller reports its finite range", () => {
    const tiles = timelineWaveformTiles({
      clip: clip(),
      clipStart: 0,
      clipDuration: 1_383.416667,
      pixelsPerSecond: 44,
      visibleRange: { start: 0, end: Number.POSITIVE_INFINITY },
    });

    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(3);
  });

  it("maps reverse playback tiles back through descending source time", () => {
    const [tile] = timelineWaveformTiles({
      clip: clip({ trim_in: 10, trim_out: 20, reverse: true }),
      clipStart: 5,
      clipDuration: 10,
      pixelsPerSecond: 100,
      visibleRange: { start: 5, end: 12 },
    });

    expect(tile.sourceTimes[0]).toBeGreaterThan(tile.sourceTimes.at(-1));
    expect(tile.sourceStartSec).toBeLessThan(tile.sourceEndSec);
  });

  it("preserves non-linear source spacing for speed ramps", () => {
    const [tile] = timelineWaveformTiles({
      clip: clip({
        trim_out: 10,
        speed_keyframes: [
          { source_sec: 0, speed: 0.5 },
          { source_sec: 5, speed: 2 },
          { source_sec: 10, speed: 2 },
        ],
      }),
      clipStart: 0,
      clipDuration: 12.5,
      pixelsPerSecond: 100,
      visibleRange: { start: 0, end: 12.5 },
      tileWidthPx: 2_000,
    });

    const earlyDelta = tile.sourceTimes[1] - tile.sourceTimes[0];
    const lateDelta = tile.sourceTimes.at(-1) - tile.sourceTimes.at(-2);
    expect(lateDelta).toBeGreaterThan(earlyDelta * 3);
  });
});
